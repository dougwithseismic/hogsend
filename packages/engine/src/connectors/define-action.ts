import type { Database } from "@hogsend/db";
import type { Logger } from "../lib/logger.js";

/**
 * Connector OUTBOUND ACTIONS — the journey-callable, socket-free face of a
 * connector. Distinct from event fan-out (the durable `emitOutbound` →
 * destination spine): an action is an IMPERATIVE call a journey/workflow makes
 * ("post this to #general", "@mention these members", "DM this user"). On
 * Discord these are pure bot-REST calls needing only the bot token — so they run
 * on ANY replica and are INDEPENDENT of the inbound gateway socket (a deployment
 * with the gateway off can still send).
 *
 * A platform plugin contributes actions (e.g. `discordActions`); the consumer
 * registers them via `createHogsendClient({ connectorActions })`. A journey
 * invokes one through the standalone {@link sendConnectorAction} export (NOT on
 * `ctx` — features are standalone imports, mirroring `sendEmail()`).
 */
/** A contact resolved for an outbound action — a platform-neutral projection. */
export interface ResolvedActionContact {
  id: string;
  email: string | null;
  discordId: string | null;
  externalId: string | null;
  properties: Record<string, unknown>;
}

export interface ConnectorActionCtx {
  db: Database;
  logger: Logger;
  /**
   * Resolve a contact by email, external id, or a platform id (e.g. a Discord
   * snowflake). The engine owns the contacts schema, so a plugin action resolves
   * a recipient WITHOUT coupling to `@hogsend/db`. Null when no live contact
   * matches.
   */
  resolveContact(ref: string): Promise<ResolvedActionContact | null>;
}

/**
 * Declares an action MEMBER-DIRECTED — aimed at an individual recipient rather
 * than a channel/ops surface. Its presence gates the action on the recipient's
 * channel preferences (the auto-registered per-connector opt-out list) before
 * the plugin runs; enforcement lands in a later phase. Absent audience =
 * ops/channel-directed = never gated.
 */
export interface MemberAudience<A = unknown> {
  kind: "member";
  /**
   * Candidate recipient refs (email | externalId | platform id | namespaced key
   * like "telegram:<chatId>"), tried in order; first resolving contact wins.
   * Returning undefined (or throwing) fails OPEN — the send proceeds.
   *
   * Method shorthand (bivariant) so a `DefinedConnectorAction<DmArgs, …>` stays
   * assignable to the erased `DefinedConnectorAction[]` the registry/plugin
   * index files use (same reason `run` is method shorthand).
   */
  ref(args: A): string | string[] | undefined;
}

export interface DefinedConnectorAction<A = unknown, R = unknown> {
  /** The connector this action belongs to (e.g. "discord"). Keys the registry. */
  connectorId: string;
  /** Action name, unique within the connector (e.g. "sendChannelMessage"). */
  name: string;
  /** Optional human description (Studio enumeration / docs). */
  description?: string;
  /**
   * When set, declares the action member-directed: the engine will gate it on
   * the recipient's channel preferences before the plugin runs (enforcement
   * lands in a later phase). Absent = ops/channel-directed = never gated.
   */
  audience?: MemberAudience<A>;
  /** Perform the outbound action. Single-object-in, result-out. */
  run(args: A, ctx: ConnectorActionCtx): Promise<R>;
}

/** Identity/validating authoring helper (mirrors `defineConnector`/`defineDestination`). */
export function defineConnectorAction<A, R>(
  def: DefinedConnectorAction<A, R>,
): DefinedConnectorAction<A, R> {
  return def;
}

/**
 * The verdict returned when the engine SKIPS a member-directed connector action
 * because the resolved recipient opted out — either the global master opt-out
 * (`unsubscribed_all`) or the per-connector channel list (`channel_unsubscribed`).
 *
 * A plain JSON-safe POJO so it is memo-recordable and replays VERBATIM through
 * both the Hatchet durable `memo` (Layer 1) AND the `connector_deliveries.result`
 * jsonb round-trip (Layer 2) — although a skip in practice NEVER writes a
 * delivery row (the gate runs BEFORE the ledger claim), so a skip is observable
 * only via logs + this returned value.
 *
 * The shape DELIBERATELY does NOT mimic per-action result shapes (it carries no
 * `messageId`/`delivered`): the `skipped: true` discriminant must be
 * unambiguous. An existing consumer reading `result.delivered` gets `undefined`
 * (falsy) on a skip — which degrades in the correct direction (treated as "not
 * delivered").
 */
export interface ConnectorActionSkipped {
  skipped: true;
  reason: "unsubscribed_all" | "channel_unsubscribed";
  connectorId: string;
  action: string;
}

/**
 * Narrow an outbound-action result to a {@link ConnectorActionSkipped} verdict.
 * Checks a non-null object with `skipped === true` plus string
 * `reason`/`connectorId`/`action` — enough to disambiguate from every per-action
 * result shape.
 */
export function isConnectorActionSkipped(
  r: unknown,
): r is ConnectorActionSkipped {
  if (typeof r !== "object" || r === null) return false;
  const v = r as Record<string, unknown>;
  return (
    v.skipped === true &&
    typeof v.reason === "string" &&
    typeof v.connectorId === "string" &&
    typeof v.action === "string"
  );
}
