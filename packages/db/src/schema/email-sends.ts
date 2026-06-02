import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
    resendId: text("resend_id"),
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
    ...timestamps,
  },
  (table) => [
    index("email_sends_to_email_idx").on(table.toEmail),
    index("email_sends_template_key_idx").on(table.templateKey),
    index("email_sends_status_idx").on(table.status),
    index("email_sends_created_at_idx").on(table.createdAt),
    index("email_sends_journey_state_id_idx").on(table.journeyStateId),
    index("email_sends_user_id_idx").on(table.userId),
    // Serves the frequency-cap COUNT (recipient + recency, optionally category).
    index("email_sends_freq_cap_idx").on(
      table.toEmail,
      table.createdAt,
      table.category,
    ),
  ],
);
