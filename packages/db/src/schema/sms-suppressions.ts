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
 * AND phone-level consent record for the SMS channel, separate from
 * email_preferences (which is keyed (user_id, email) and cannot hold an
 * unresolvable phone). An inbound STOP from a number that resolves to NO
 * contact still lands here, satisfying the TCPA requirement to suppress
 * regardless of identity.
 *
 * TRI-STATE per phone (unique index):
 *  - row with `resubscribed_at IS NULL` — ACTIVE suppression (STOP / permanent
 *    carrier failure / manual): blocks every send, including transactional.
 *  - row with `resubscribed_at` set — EXPRESS phone-level consent: texting
 *    START (or an API grant for a phone-only contact) is prior express
 *    consent under the explicit-opt-in model, recorded with its timestamp.
 *  - no row — neither; a marketing send needs a `categories.sms === true`
 *    grant on `email_preferences` or it fails closed (`no_consent`).
 *
 * A START/UNSTOP upserts `resubscribed_at = now()` (a fresh START with no
 * prior STOP row still grants); a subsequent STOP flips it back
 * (`suppressed_at = now(), resubscribed_at = null`). The row is NEVER
 * deleted — opt-out/consent records are retained (TCPA/CTIA record-keeping).
 */
export const smsSuppressions = pgTable(
  "sms_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: text("phone").notNull(),
    // Why the LAST state transition happened: "inbound_stop" (STOP keyword),
    // "carrier_permanent" (a permanent-class provider failure —
    // invalid/unreachable number, mirrors email hard-bounce auto-suppress),
    // "manual" (admin/API opt-out), "inbound_start" (consent granted via
    // START with no prior row), or "api_grant" (consent granted via the lists
    // API for a phone-only contact).
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
