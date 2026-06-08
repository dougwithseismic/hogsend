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
    // The delivery adapter selector. "webhook" (the default) is the signed
    // Standard-Webhooks POST that existing subscribers receive — byte-identical
    // to before this column existed. Any other value (e.g. "posthog") selects a
    // delivery-time TRANSFORM adapter that reuses the same durable delivery
    // machinery but rewrites url/headers/body for a vendor destination.
    kind: text("kind").notNull().default("webhook"),
    // Per-destination configuration for keyed adapters (e.g. PostHog's
    // `{ apiKey, host }`). Null for `kind="webhook"` (it reads `secret` instead).
    // Keyed destinations keep their credentials HERE, not in a fake `whsec_`.
    config: jsonb("config").$type<Record<string, unknown>>(),
    // whsec_<base64url> PLAINTEXT (recoverable; re-signed every delivery).
    // Nullable: only `kind="webhook"` carries a signing secret; keyed
    // destinations authenticate via `config` and the webhook adapter is the only
    // reader of this column.
    secret: text("secret"),
    // e.g. "whsec_AbCd" — safe to show on list/get. Nullable alongside `secret`.
    secretPrefix: text("secret_prefix"),
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
