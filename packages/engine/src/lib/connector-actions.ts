import { contacts, type Database } from "@hogsend/db";
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
 * Resolve a contact for an outbound action by email, external id, or a platform
 * id (e.g. a Discord snowflake). Matches text columns only (NOT the uuid `id`,
 * which would force an invalid-uuid cast error for an email ref). First live
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

  // Layer-1 (eviction-gated) replay protection. Connector actions (Telegram /
  // Discord REST sends) have NO Layer-2 DB backstop — there is no deliveries
  // table to dedupe against — so on a degraded (pre-eviction) engine a replay
  // CAN still double-send. When eviction is live this memoize makes the action
  // exactly-once for free; the key is content/site-derived exactly like sends so
  // two distinct actions on divergent branches stay apart. A Layer-2 backstop
  // (connector_deliveries table / Redis SETNX) is a documented follow-up.
  const boundary = getJourneyBoundary();
  if (boundary) {
    const site =
      boundary.currentLabel ?? `${input.connectorId}:${input.action}`;
    const key = deriveJourneyKey({
      kind: "connector",
      anchor: boundary.runAnchor,
      site,
      discriminant: `${input.connectorId}:${input.action}`,
    });
    registerKey(boundary, key);
    return boundary.memoize([key], doRun);
  }

  return doRun();
}
