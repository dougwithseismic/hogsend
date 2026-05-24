import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { emailSendStatusEnum } from "./enums.js";
import { journeyStates } from "./journey-states.js";

export const emailSends = pgTable("email_sends", {
  id: uuid("id").defaultRandom().primaryKey(),
  journeyStateId: uuid("journey_state_id").references(() => journeyStates.id),
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
  ...timestamps,
});
