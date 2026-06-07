import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { webhookDeliveryStatusEnum } from "./enums.js";
import { webhookEndpoints } from "./webhook-endpoints.js";

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    // internal PK ONLY — NOT the Webhook-Id header.
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    // denormalized, nullable (MT deferred).
    organizationId: text("organization_id"),
    // == Webhook-Id header; ONE per logical event, shared across endpoints +
    // reused across retries.
    webhookId: text("webhook_id").notNull(),
    eventType: text("event_type").notNull(),
    // producer-side dedup (idempotencyKey/stateId/emailSendId/...).
    dedupeKey: text("dedupe_key"),
    // the EXACT signed envelope { id, type, timestamp, data }.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    // truncated to ≤1KB in app.
    responseBodySnippet: text("response_body_snippet"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    index("webhook_deliveries_endpoint_idx").on(table.endpointId),
    // reaper sweep: due-pending + stale-sending recovery.
    index("webhook_deliveries_status_next_retry_idx").on(
      table.status,
      table.nextRetryAt,
    ),
    // producer-side fan-out idempotency. PARTIAL-effective: Postgres treats
    // multiple NULL dedupeKey as distinct, so undeduped events are never blocked.
    uniqueIndex("webhook_deliveries_endpoint_dedupe_idx").on(
      table.endpointId,
      table.dedupeKey,
    ),
  ],
);
