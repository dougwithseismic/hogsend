import { connectorDeliveries, contacts, type Database } from "@hogsend/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { getConnectorActionRegistry } from "../connectors/action-registry-singleton.js";
import type { ResolvedActionContact } from "../connectors/define-action.js";
import { env } from "../env.js";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";

/**
 * Matches the canonical UUID form of `contacts.id` (8-4-4-4-12 hex). Gates the
 * `eq(contacts.id, ref)` leg so a uuid comparison only runs for a genuinely
 * uuid-shaped ref — an email/snowflake ref would otherwise raise a Postgres
 * `22P02 invalid input syntax for type uuid`.
 */
const CONTACT_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a contact for an outbound action by its canonical key in ANY form:
 * email, external id, a platform id (a Discord snowflake / anonymous id), or —
 * when the ref is uuid-shaped — the contact's row `id`. Matching every canonical
 * key form (the journey subject key is `external_id ?? anonymous_id ?? id`) lets
 * `member: user.id` resolve a member who has NOT linked (an anonymous Discord
 * contact keyed by its uuid) or an email-only member. The uuid `id` leg is
 * shape-gated: `contacts.id` is a uuid column and an unguarded `eq(id, ref)`
 * against an email/snowflake text ref throws an invalid-uuid cast. First live
 * match wins.
 */
async function resolveContact(
  db: Database,
  ref: string,
): Promise<ResolvedActionContact | null> {
  if (!ref) return null;
  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.email,
      discordId: contacts.discordId,
      externalId: contacts.externalId,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(
      and(
        isNull(contacts.deletedAt),
        or(
          eq(contacts.email, ref),
          eq(contacts.externalId, ref),
          eq(contacts.discordId, ref),
          eq(contacts.anonymousId, ref),
          ...(CONTACT_ID_UUID.test(ref) ? [eq(contacts.id, ref)] : []),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email ?? null,
    discordId: row.discordId ?? null,
    externalId: row.externalId ?? null,
    properties: (row.properties ?? {}) as Record<string, unknown>,
  };
}

export interface SendConnectorActionArgs {
  /** The connector the action belongs to (e.g. "discord"). */
  connectorId: string;
  /** The action name (e.g. "sendChannelMessage"). */
  action: string;
  /** The action's own args object (shape defined by the action). */
  args?: unknown;
  /**
   * Disambiguates the exactly-once dedupe key when the SAME action is sent more
   * than once in one journey run. The action's `args` are NOT part of the
   * derived key, so two genuinely-distinct sends of the same action within one
   * run — without an intervening `ctx.sleep`/`waitForEvent`/`checkpoint` to
   * advance the nearest label — would otherwise derive an IDENTICAL key and the
   * second would fail-fast via `registerKey`. Pass a distinct label per call
   * (e.g. broadcasting the same message to two channels back-to-back). Mirrors
   * `idempotencyLabel` on `sendEmail()` and `ctx.trigger()`. Additive and
   * optional.
   */
  idempotencyLabel?: string;
}

/**
 * Invoke a registered connector outbound action from a journey/workflow. The
 * standalone, socket-free counterpart to `sendEmail()` — single-object-in,
 * result-out, NOT on `JourneyContext` (features are standalone imports). Throws
 * when the action isn't registered (wire it via
 * `createHogsendClient({ connectorActions })`).
 *
 * Independent of any inbound gateway runtime: a deployment with the gateway off
 * (or "Worker Offline") can still send — Discord actions are bot-REST needing
 * only the bot token.
 */
export async function sendConnectorAction(
  input: SendConnectorActionArgs,
): Promise<unknown> {
  const action = getConnectorActionRegistry().get(
    input.connectorId,
    input.action,
  );
  if (!action) {
    throw new Error(
      `no connector action "${input.connectorId}:${input.action}" is registered ` +
        "(pass it via createHogsendClient({ connectorActions }))",
    );
  }
  const db = getDb();
  const doRun = () =>
    action.run(input.args, {
      db,
      logger: createLogger(env.LOG_LEVEL),
      resolveContact: (ref: string) => resolveContact(db, ref),
    });

  // Outside a journey run (an admin/manual send) there is no replay to defend
  // against and no boundary to key from — run the action directly.
  const boundary = getJourneyBoundary();
  if (!boundary) return doRun();

  // The replay-stable, branch-derived key shared by BOTH defense layers. `site`
  // = the explicit `idempotencyLabel` ?? the nearest authored wait/checkpoint
  // label (so two of the SAME action on divergent branches derive distinct keys
  // for free) ?? the connector:action. Mirrors sendEmail()/ctx.trigger().
  const site =
    input.idempotencyLabel ??
    boundary.currentLabel ??
    `${input.connectorId}:${input.action}`;
  const discriminant = `${input.connectorId}:${input.action}`;
  const key = deriveJourneyKey({
    kind: "connector",
    anchor: boundary.runAnchor,
    site,
    discriminant,
  });
  registerKey(boundary, key);

  // Layer 1 (eviction-gated, FREE) fast path wrapping the Layer-2-backed run.
  // When the engine supports eviction the durable `memo()` skips the action —
  // and the DB round-trip below — entirely on a replay. When it does NOT (a
  // pre-eviction / ':latest'-drifted engine), `memoize` falls through to the
  // closure and Layer 2 (the `connector_deliveries` short-circuit) is the
  // version-INDEPENDENT exactly-once guarantee. Belt-and-suspenders, mirroring
  // the email send path (tracked.ts).
  return boundary.memoize([key], () =>
    runWithConnectorDelivery({
      db,
      connectorId: input.connectorId,
      action: input.action,
      dedupeKey: key,
      run: doRun,
    }),
  );
}

interface ConnectorDeliveryArgs {
  db: Database;
  connectorId: string;
  action: string;
  dedupeKey: string;
  run: () => Promise<unknown>;
}

/**
 * Layer-2 (version-independent) DB backstop for a connector action, mirroring
 * the `email_sends.idempotencyKey` short-circuit in tracked.ts:
 *
 *  1. SELECT by `(connectorId, dedupeKey)` — a TERMINAL-success ("sent") prior
 *     row is a satisfied duplicate: return its stored `result` WITHOUT
 *     re-running the action. A "queued" prior row is NOT satisfied (a prior
 *     attempt claimed the key but may have died before the action returned) —
 *     re-drive it (safer missed>doubled), matching the MF-2 fix in tracked.ts.
 *  2. INSERT `onConflictDoNothing` to claim the key; on a concurrent loser,
 *     re-read the winner and apply the same satisfied/queued rule.
 *  3. Run the action, then UPDATE the claimed row with the JSON-round-tripped
 *     result + "sent". On a thrown action, stamp "failed" AND release the key
 *     (set null) so a retry genuinely re-attempts rather than deduping to it.
 */
async function runWithConnectorDelivery(
  args: ConnectorDeliveryArgs,
): Promise<unknown> {
  const { db, connectorId, action, dedupeKey, run } = args;

  // 1. Up-front short-circuit: a prior terminal-success row replays its result.
  const existing = await db
    .select({
      id: connectorDeliveries.id,
      status: connectorDeliveries.status,
      result: connectorDeliveries.result,
    })
    .from(connectorDeliveries)
    .where(
      and(
        eq(connectorDeliveries.connectorId, connectorId),
        eq(connectorDeliveries.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);

  const prior = existing[0];
  let rowId: string;
  if (prior) {
    if (prior.status === "sent") return prior.result;
    // Only a "queued" row can reach here: this SELECT is keyed on the (non-null)
    // dedupeKey, and the failure path nulls the key (see below), so a "failed"
    // row is never returned by the keyed lookup. A post-failure retry therefore
    // takes the INSERT-new-row branch below — it never re-drives a failed row.
    // Re-drive the queued row against the same id (the unique index is honored).
    rowId = prior.id;
  } else {
    // 2. Claim the key. Swallow a concurrent-insert collision on the unique
    // index (the select above is not atomic) and resolve the winner.
    const inserted = await db
      .insert(connectorDeliveries)
      .values({ connectorId, action, dedupeKey, status: "queued" })
      .onConflictDoNothing({
        target: [
          connectorDeliveries.connectorId,
          connectorDeliveries.dedupeKey,
        ],
      })
      .returning({ id: connectorDeliveries.id });

    const insertedRow = inserted[0];
    if (insertedRow) {
      rowId = insertedRow.id;
    } else {
      // A concurrent send claimed the key first — resolve its row, applying the
      // same satisfied-vs-requeue rule.
      const winnerRows = await db
        .select({
          id: connectorDeliveries.id,
          status: connectorDeliveries.status,
          result: connectorDeliveries.result,
        })
        .from(connectorDeliveries)
        .where(
          and(
            eq(connectorDeliveries.connectorId, connectorId),
            eq(connectorDeliveries.dedupeKey, dedupeKey),
          ),
        )
        .limit(1);
      const winner = winnerRows[0];
      if (!winner) throw new Error("Failed to claim connector_deliveries row");
      if (winner.status === "sent") return winner.result;
      // As above, the winner can only be "sent" or "queued": a "failed" row has
      // a null dedupeKey and is never returned by this keyed lookup.
      rowId = winner.id;
    }
  }

  // 3. Run the action and persist the (JSON-round-tripped) result. `result`
  // survives the jsonb column, so a later replay returns the SAME value.
  // Normalize an `undefined` action result to `null` on write: an action may
  // legitimately return nothing (a fire-and-forget send with no message id),
  // and Drizzle's `mapUpdateSet` drops `undefined` values from the UPDATE — so
  // an unnormalized `undefined` would leave the column at its NULL default and a
  // later short-circuit would replay `null`, NOT the `undefined` the first run
  // observed. Coercing here makes both the first run and every replay observe
  // the SAME value (`null`), keeping the round-trip claim literally true.
  try {
    const result = await run();
    const now = new Date();
    await db
      .update(connectorDeliveries)
      .set({
        result: (result === undefined ? null : result) as unknown,
        status: "sent",
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(connectorDeliveries.id, rowId));
    return result === undefined ? null : result;
  } catch (error) {
    // Release the key (set null) so a retry genuinely re-attempts rather than
    // deduping to this failed row — exactly like the tracked-mailer failed path.
    await db
      .update(connectorDeliveries)
      .set({
        status: "failed",
        dedupeKey: null,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      })
      .where(eq(connectorDeliveries.id, rowId));
    throw error;
  }
}
