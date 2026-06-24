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
import { emailSendStatusEnum } from "./enums.js";
import { journeyStates } from "./journey-states.js";

export const emailSends = pgTable(
  "email_sends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    journeyStateId: uuid("journey_state_id").references(() => journeyStates.id),
    // Denormalized recipient identity, set at send time. Lets reporting attribute
    // a send to a contact without joining journey_states, and captures journeyless
    // (raw/batch) sends that have no journey linkage. Both nullable.
    userId: text("user_id"),
    userEmail: text("user_email"),
    templateKey: text("template_key"),
    messageId: text("message_id"),
    fromEmail: text("from_email").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    category: text("category"),
    status: emailSendStatusEnum("status").notNull().default("queued"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    bouncedAt: timestamp("bounced_at", { withTimezone: true }),
    complainedAt: timestamp("complained_at", { withTimezone: true }),
    // Bounce classification from the Resend webhook (hard/soft/transient + reason).
    bounceType: text("bounce_type"),
    bounceReason: text("bounce_reason"),
    // Deterministic idempotency key. A retry/replay with the same key
    // short-circuits to the prior send instead of dispatching a duplicate —
    // mirrors the user_events idempotency pattern. Set by:
    //   • POST /v1/emails — the caller-supplied key.
    //   • Journey sends — the engine auto-derives
    //     `journeySend:<runAnchor>:<site>:<template>` (runAnchor = the replay-
    //     stable Hatchet run id; site = the nearest authored wait label, or an
    //     explicit `idempotencyLabel`) so a durable replay re-firing the same
    //     logical send is absorbed here.
    // Nullable ONLY for legacy/admin-raw sends (sendRaw writes no row at all);
    // NULLs are distinct in Postgres so those never collide.
    idempotencyKey: text("idempotency_key"),
    // Free-form per-send annotations. Set ONLY by test-mode redirected sends
    // today — `{ testMode: true, originalTo: <real recipient> }` — so Studio can
    // flag a TEST row and show who the mail was REALLY for. Nullable: normal
    // (live) sends leave it unset. jsonb (mirrors alert-history.payload) leaves
    // room for future markers without another migration.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    index("email_sends_to_email_idx").on(table.toEmail),
    index("email_sends_template_key_idx").on(table.templateKey),
    index("email_sends_status_idx").on(table.status),
    index("email_sends_created_at_idx").on(table.createdAt),
    index("email_sends_journey_state_id_idx").on(table.journeyStateId),
    index("email_sends_user_id_idx").on(table.userId),
    // Serves the provider-webhook by-message resolver
    // (resolveEmailSendContextByMessageId) — previously a seq-scan.
    index("email_sends_message_id_idx").on(table.messageId),
    // Serves the frequency-cap COUNT (recipient + recency, optionally category).
    index("email_sends_freq_cap_idx").on(
      table.toEmail,
      table.createdAt,
      table.category,
    ),
    // Idempotency dedup for POST /v1/emails (NULLs are distinct in Postgres, so
    // unkeyed journey/system sends never collide).
    uniqueIndex("email_sends_idempotency_key_idx").on(table.idempotencyKey),
  ],
);
