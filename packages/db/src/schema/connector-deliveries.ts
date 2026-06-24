import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { connectorDeliveryStatusEnum } from "./enums.js";

/**
 * Layer-2 (version-independent) replay-dedupe backstop for connector outbound
 * actions (Telegram / Discord REST sends). The free Layer-1 Hatchet `memo()`
 * fast path in `sendConnectorAction` is only durable on an engine that supports
 * eviction (>= v0.80.0); on a degraded (pre-eviction or ':latest'-drifted)
 * engine a replay-from-top would otherwise re-send the message. This table is
 * the durable guarantee that closes that gap — exactly the role
 * `email_sends.idempotencyKey` plays for sends and `webhook_deliveries`'
 * `(endpointId, dedupeKey)` plays for outbound webhooks.
 *
 * Lifecycle (mirrors the email_sends short-circuit):
 *   1. SELECT by (connectorId, dedupeKey) — a TERMINAL-success ("sent") prior
 *      row is a satisfied duplicate: return its stored `result` WITHOUT
 *      re-running the action.
 *   2. A "queued" prior row is NOT a satisfied duplicate (a prior attempt
 *      claimed the key but the worker may have died before the action returned)
 *      — re-drive the action (safer missed>doubled), matching the MF-2 fix in
 *      tracked.ts.
 *   3. Otherwise INSERT `onConflictDoNothing` on the unique index, run the
 *      action, then UPDATE the row with the JSON-serialized result + "sent".
 *   4. On a thrown action, stamp "failed" AND release the key (set null) so a
 *      retry genuinely re-attempts — never deduping to the failed row.
 */
export const connectorDeliveries = pgTable(
  "connector_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The connector the action belongs to (e.g. "discord" / "telegram").
    // Scopes the dedupe key so one engine can serve many connectors.
    connectorId: text("connector_id").notNull(),
    // The action name (e.g. "sendChannelMessage") — denormalized for
    // observability; the dedupe key already encodes it.
    action: text("action").notNull(),
    // Producer-side dedupe key: `deriveJourneyKey({ kind: "connector", ... })`
    // — the replay-stable, branch-derived key shared with the Layer-1 memoize.
    // Nullable so a non-journey (boundary-less) send is never blocked: Postgres
    // treats multiple NULLs as distinct under the unique index.
    dedupeKey: text("dedupe_key"),
    // The JSON-serialized action result (e.g. `{ messageId }`) replayed back to
    // a duplicate caller. Stored as the value the action returned, round-tripped
    // through JSON, so a replay returns the SAME result without re-sending.
    result: jsonb("result").$type<unknown>(),
    status: connectorDeliveryStatusEnum("status").notNull().default("queued"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Producer-side action idempotency. PARTIAL-effective: Postgres treats
    // multiple NULL dedupeKey as distinct, so un-keyed (boundary-less) sends are
    // never blocked.
    uniqueIndex("connector_deliveries_connector_dedupe_idx").on(
      table.connectorId,
      table.dedupeKey,
    ),
    // Observability sweep: recent deliveries per connector.
    index("connector_deliveries_connector_idx").on(
      table.connectorId,
      table.createdAt,
    ),
  ],
);
