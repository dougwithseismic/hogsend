import { connectorDeliveries, contacts, type Database } from "@hogsend/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getConnectorActionRegistry } from "../connectors/action-registry-singleton.js";
import type {
  ConnectorActionSkipped,
  DefinedConnectorAction,
  ResolvedActionContact,
} from "../connectors/define-action.js";
import {
  deriveJourneyKey,
  getJourneyBoundary,
  registerKey,
} from "../journeys/journey-boundary.js";
import { getListRegistry } from "../lists/registry-singleton.js";
import { getDb } from "./db.js";
import { createLogger } from "./logger.js";
import { readRecipientPreferences } from "./recipient-preferences.js";

// This module is part of the side-effect-free journey-authoring surface used by
// `@hogsend/testing`. Reading the raw optional value keeps importing a journey
// from validating the complete production environment; the full container still
// validates env at boot.
const logger = createLogger(process.env.LOG_LEVEL);

/**
 * Matches the canonical UUID form of `contacts.id` (8-4-4-4-12 hex). Gates the
 * `eq(contacts.id, ref)` leg so a uuid comparison only runs for a genuinely
 * uuid-shaped ref — an email/snowflake ref would otherwise raise a Postgres
 * `22P02 invalid input syntax for type uuid`.
 */
const CONTACT_ID_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Matches a NAMESPACED platform ref (`telegram:<chatId>`, `discord:<id>`, …):
 * a leading `<namespace>:` followed by a non-empty value. Captures the namespace
 * (group 1) and the value (group 2).
 */
const NAMESPACED_REF = /^([a-z][a-z0-9_-]*):(.+)$/i;

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
 *
 * NAMESPACED refs (`telegram:<chatId>`) ADDITIONALLY match the platform metadata
 * under `properties.<namespace>` (the `chat_id`/`id` fields). This is load-bearing
 * for the PRIMARY "reach an existing app user on a chat platform" case: when a
 * platform links onto an ALREADY-identified contact, the engine keeps the row's
 * `external_id = <app id>` and stores the chat id ONLY under
 * `properties.<namespace>` (the DEEP_MERGE_KEYS convention in lib/contacts.ts) —
 * the `telegram:<id>` key is NEVER promoted to `external_id` nor aliased. Without
 * these legs `resolveContact("telegram:<chatId>")` would miss that population and
 * a preference gate would wrongly ALLOW a send to an opted-out user. Both the
 * namespace key and the value are SQL-parameterized (never string-interpolated).
 * PERF: these two legs are un-indexed jsonb reads — acceptable at DM volume; a
 * partial index on `properties -> '<ns>' ->> 'chat_id'` is the follow-up if it
 * ever gets hot.
 */
async function resolveContact(
  db: Database,
  ref: string,
): Promise<ResolvedActionContact | null> {
  if (!ref) return null;
  // A namespaced ref (telegram:<chatId>) additionally matches the platform
  // metadata a link-onto-identified contact stores only in properties.<ns>.
  const nsMatch = NAMESPACED_REF.exec(ref);
  const namespacedLegs = nsMatch
    ? [
        sql`${contacts.properties} -> ${nsMatch[1]}::text ->> 'chat_id' = ${nsMatch[2]}`,
        sql`${contacts.properties} -> ${nsMatch[1]}::text ->> 'id' = ${nsMatch[2]}`,
      ]
    : [];
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
          ...namespacedLegs,
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

/**
 * Preference gate for a member-directed outbound action. Returns a
 * {@link ConnectorActionSkipped} verdict when the resolved recipient has opted
 * out, or `null` when the send is allowed.
 *
 * Gating rules:
 *  - An action WITHOUT a member audience (`audience?.kind !== "member"`) is
 *    ops/channel-directed (grantRole, broadcast, mentions, channel messages) and
 *    is NEVER gated — returns null immediately.
 *  - The audience extractor is run inside a try/catch: a THROWING extractor
 *    FAILS OPEN (`logger.warn` + null) — a bad extractor must never brick a
 *    journey that works today.
 *  - Candidate refs are tried in order; the FIRST that resolves a live contact
 *    wins. A candidate that resolves NO contact (a raw snowflake, a group-chat
 *    id, an unlinked ref) means there is NO preference surface to consult — the
 *    send is ALLOWED (null). Only once a contact is resolved do preferences gate.
 *  - On a resolved contact we read the aggregated {@link readRecipientPreferences}
 *    keyed by its email + `externalId ?? id` (the SAME key form preference writes
 *    use), then: `unsubscribedAll` → skip `unsubscribed_all`; else channel
 *    opt-out (`!getListRegistry().isSubscribed(categories, connectorId)`) → skip
 *    `channel_unsubscribed`; else null.
 *
 * Deliberately does NOT consume `prefs.suppressed` — that is an email-transport
 * hard-bounce/complaint signal, irrelevant to a chat channel.
 */
async function checkActionAudience(
  db: Database,
  resolveCachedContact: (ref: string) => Promise<ResolvedActionContact | null>,
  action: DefinedConnectorAction,
  connectorId: string,
  actionName: string,
  args: unknown,
): Promise<ConnectorActionSkipped | null> {
  // Ops/channel-directed actions carry no member audience — never gated.
  if (action.audience?.kind !== "member") return null;

  // Extract candidate recipient refs. A throwing extractor fails OPEN so a
  // gating bug can never regress a send that works today.
  let candidates: string[];
  try {
    const raw = action.audience.ref(args);
    candidates = (Array.isArray(raw) ? raw : [raw]).filter(
      (r): r is string => typeof r === "string" && r.length > 0,
    );
  } catch (error) {
    logger.warn("connector action audience extractor threw; sending anyway", {
      connectorId,
      action: actionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  for (const ref of candidates) {
    const contact = await resolveCachedContact(ref);
    // No contact for this candidate → no preference surface → try the next; a
    // fully-unresolved recipient (raw id / group chat) falls through to allow.
    if (!contact) continue;

    const prefs = await readRecipientPreferences(db, {
      email: contact.email,
      userId: contact.externalId ?? contact.id,
    });
    if (prefs.unsubscribedAll) {
      return {
        skipped: true,
        reason: "unsubscribed_all",
        connectorId,
        action: actionName,
      };
    }
    if (!getListRegistry().isSubscribed(prefs.categories, connectorId)) {
      return {
        skipped: true,
        reason: "channel_unsubscribed",
        connectorId,
        action: actionName,
      };
    }
    return null;
  }

  // No candidate resolved a contact → allowed (no preference surface).
  return null;
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
 *
 * MEMBER-DIRECTED actions (those declaring `audience: { kind: "member" }`) are
 * automatically gated on the recipient's channel preferences BEFORE the plugin
 * runs: a resolved contact who unsubscribed globally or opted out of the
 * connector's channel list yields a {@link ConnectorActionSkipped} verdict
 * INSTEAD of a send, and no `connector_deliveries` row is claimed. The gate runs
 * INSIDE the durable memo closure, so its verdict is recorded and replays
 * verbatim (THE LAW: the key derivation, `registerKey`, and the `memoize` call
 * itself stay unconditional). Skips are observable via logs + the returned
 * verdict only — an audit ledger is a future additive migration. Ops/channel-
 * directed actions (no audience) are never gated.
 */
export async function sendConnectorAction(
  input: SendConnectorActionArgs,
): Promise<unknown> {
  const boundary = getJourneyBoundary();
  const override = boundary?.services?.connector;
  if (boundary && override) {
    const actionExists = boundary.services?.connectorActionExists;
    if (!actionExists) {
      throw new Error(
        "Scoped connector override requires connectorActionExists validation",
      );
    }
    if (!actionExists(input.connectorId, input.action)) {
      throw new Error(
        `no connector action "${input.connectorId}:${input.action}" is registered ` +
          "(pass it via createJourneyTest({ connectorActions }))",
      );
    }
    const site =
      input.idempotencyLabel ??
      boundary.currentLabel ??
      `${input.connectorId}:${input.action}`;
    const scopedKey = deriveJourneyKey({
      kind: "connector",
      anchor: boundary.runAnchor,
      site,
      discriminant: `${input.connectorId}:${input.action}`,
    });
    registerKey(boundary, scopedKey);
    return boundary.memoize([scopedKey], () =>
      override({
        connectorId: input.connectorId,
        action: input.action,
        ...(input.args !== undefined ? { args: input.args } : {}),
        idempotencyKey: scopedKey,
      }),
    );
  }

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

  // Per-call promise-memoized contact resolver so the preference gate and the
  // plugin share ONE contacts round-trip per ref: `checkActionAudience` and the
  // plugin's `ctx.resolveContact` would otherwise resolve the SAME member ref
  // twice. Scoped to THIS call (never module-level) — a durable replay rebuilds
  // it fresh; it adds/removes no durable calls and lives inside the memoized
  // closure's execution, never moving the gate outside it (THE LAW).
  const contactCache = new Map<string, Promise<ResolvedActionContact | null>>();
  const resolveCached = (ref: string) => {
    let p = contactCache.get(ref);
    if (!p) {
      p = resolveContact(db, ref);
      contactCache.set(ref, p);
    }
    return p;
  };

  const doRun = () =>
    action.run(input.args, {
      db,
      logger,
      resolveContact: resolveCached,
    });

  // Preference gate shared by BOTH the no-boundary and memoized paths: consult
  // the recipient's channel preferences and either short-circuit with a skip
  // verdict (memo-recorded so it replays verbatim) or invoke `run`.
  const gate = async (run: () => Promise<unknown>): Promise<unknown> => {
    const skip = await checkActionAudience(
      db,
      resolveCached,
      action,
      input.connectorId,
      input.action,
      input.args,
    );
    if (skip) {
      logger.info("connector action skipped: recipient preferences", {
        connectorId: input.connectorId,
        action: input.action,
        reason: skip.reason,
      });
      return skip;
    }
    return run();
  };

  // Outside a journey run (an admin/manual send) there is no replay to defend
  // against and no boundary to key from — gate then run the action directly.
  if (!boundary) return gate(doRun);

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
  // When the engine supports eviction the durable `memo()` skips the closure —
  // the preference gate, the action, AND the DB round-trip below — entirely on a
  // replay, replaying whatever the FIRST run recorded (a skip verdict OR the
  // send result). When it does NOT (a pre-eviction / ':latest'-drifted engine),
  // `memoize` falls through to the closure and Layer 2 (the
  // `connector_deliveries` short-circuit) is the version-INDEPENDENT exactly-once
  // guarantee. Belt-and-suspenders, mirroring the email send path (tracked.ts).
  //
  // The gate runs INSIDE the closure so a skip is memo-recorded: a preference
  // flip between run and replay cannot change the recorded verdict. On a skip we
  // never reach `runWithConnectorDelivery`, so NO `connector_deliveries` row is
  // ever claimed for a skipped send (zero migrations; the enum is untouched).
  return boundary.memoize([key], () =>
    gate(() =>
      runWithConnectorDelivery({
        db,
        connectorId: input.connectorId,
        action: input.action,
        dedupeKey: key,
        run: doRun,
      }),
    ),
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
