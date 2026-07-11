import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * Phone-keyed SMS suppression list — the authoritative transport-level opt-out
 * for the SMS channel, separate from email_preferences (which is keyed
 * (user_id, email) and cannot hold an unresolvable phone). An inbound STOP from
 * a number that resolves to NO contact still lands here, satisfying the TCPA
 * requirement to suppress regardless of identity.
 *
 * A row is ACTIVE (suppressed) while `resubscribed_at IS NULL`. A START/UNSTOP
 * sets `resubscribed_at = now()`; a subsequent STOP flips it back
 * (`suppressed_at = now(), resubscribed_at = null`). The row is NEVER deleted —
 * opt-out records are retained (TCPA/CTIA record-keeping).
 */
export const smsSuppressions = pgTable(
  "sms_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: text("phone").notNull(),
    // "inbound_stop" (STOP keyword), "carrier_permanent" (a permanent-class
    // provider failure — invalid/unreachable number, mirrors email hard-bounce
    // auto-suppress), or "manual" (admin/API).
    reason: text("reason").notNull(),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // NULL = active suppression. Non-null = the number resubscribed (START) at
    // this instant; a later STOP resets it to NULL.
    resubscribedAt: timestamp("resubscribed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [uniqueIndex("sms_suppressions_phone_idx").on(table.phone)],
);
