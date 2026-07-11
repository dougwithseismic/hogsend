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
import { smsSendStatusEnum } from "./enums.js";
import { journeyStates } from "./journey-states.js";

export const smsSends = pgTable(
  "sms_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    journeyStateId: uuid("journey_state_id").references(() => journeyStates.id),
    // Denormalized recipient identity, set at send time. Mirrors email_sends:
    // lets reporting attribute a send to a contact without joining
    // journey_states, and captures journeyless (raw) sends. Nullable.
    userId: text("user_id"),
    templateKey: text("template_key"),
    messageId: text("message_id"),
    fromPhone: text("from_phone").notNull(),
    toPhone: text("to_phone").notNull(),
    // The rendered plain-text body actually handed to the provider.
    body: text("body").notNull(),
    category: text("category"),
    status: smsSendStatusEnum("status").notNull().default("queued"),
    // Provider-reported segment count (GSM-7 160/153 vs UCS-2 70/67). Recorded
    // at send time from countSmsSegments for cost/observability.
    segments: integer("segments"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    // First-click timestamp, set exactly once by the click pipeline
    // (WHERE clicked_at IS NULL) — mirrors email_sends.clickedAt.
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    // Carrier failure classification from the provider status webhook.
    errorCode: text("error_code"),
    errorReason: text("error_reason"),
    // Deterministic idempotency key — same contract as email_sends. Journey
    // sends auto-derive `journeySmsSend:<runAnchor>:<site>:<template>` (a
    // disjoint prefix from email's `journeySend:` so a send of the same
    // template on both channels under one wait label never collides). Nullable;
    // NULLs are distinct in Postgres so unkeyed/raw sends never collide.
    idempotencyKey: text("idempotency_key"),
    // Free-form per-send annotations. Set today by test-mode redirected sends
    // (`{ testMode: true, originalTo: <real recipient> }`). Nullable.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index("sms_sends_to_phone_idx").on(table.toPhone),
    index("sms_sends_template_key_idx").on(table.templateKey),
    index("sms_sends_status_idx").on(table.status),
    index("sms_sends_created_at_idx").on(table.createdAt),
    index("sms_sends_journey_state_id_idx").on(table.journeyStateId),
    index("sms_sends_user_id_idx").on(table.userId),
    // Serves the provider-webhook by-message resolver.
    index("sms_sends_message_id_idx").on(table.messageId),
    // Serves the frequency-cap COUNT (recipient + recency, optionally category).
    index("sms_sends_freq_cap_idx").on(
      table.toPhone,
      table.createdAt,
      table.category,
    ),
    // Idempotency dedup (NULLs are distinct in Postgres, so unkeyed/raw sends
    // never collide).
    uniqueIndex("sms_sends_idempotency_key_idx").on(table.idempotencyKey),
  ],
);
