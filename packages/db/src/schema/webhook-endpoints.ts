import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

// Locally declared to avoid an engine→db dependency cycle: the engine's
// `webhook-signing.ts` owns the authoritative `WEBHOOK_EVENT_TYPES` tuple +
// `WebhookEventType` union. This schema keeps a structural string alias so the
// jsonb column is typed without importing the engine.
export type WebhookEventType = string;

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    url: text("url").notNull(),
    description: text("description"),
    // whsec_<base64url> PLAINTEXT (recoverable; re-signed every delivery).
    secret: text("secret").notNull(),
    // e.g. "whsec_AbCd" — safe to show on list/get.
    secretPrefix: text("secret_prefix").notNull(),
    eventTypes: jsonb("event_types")
      .$type<WebhookEventType[]>()
      .notNull()
      .default([]),
    disabled: boolean("disabled").notNull().default(false),
    // written by the delivery task on a successful (2xx) delivery.
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("webhook_endpoints_org_idx").on(table.organizationId),
    index("webhook_endpoints_disabled_idx").on(table.disabled),
  ],
);
