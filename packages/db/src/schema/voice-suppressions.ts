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
 * Phone-keyed VOICE suppression list (internal DNC) — the authoritative
 * transport-level opt-out for the voice channel, SEPARATE from
 * `sms_suppressions`: a contact may accept SMS but refuse calls, and vice-versa,
 * so the two channels keep independent opt-out state. An "stop calling me"
 * request from a number that resolves to NO contact still lands here (like an
 * inbound SMS STOP), satisfying the requirement to honor a DNC regardless of
 * identity.
 *
 * A row is an ACTIVE suppression — voice marketing (and any non-transactional
 * call) is blocked. Rows are NEVER deleted — DNC records are retained. Operators
 * wire national/state DNC scrubbing upstream; this is the per-tenant internal
 * DNC the engine enforces on every call.
 */
export const voiceSuppressions = pgTable(
  "voice_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phone: text("phone").notNull(),
    // Why the number is on the internal DNC: "opt_out" (the callee asked to stop
    // — via the opt-out tool or an inbound request), "dnc" (admin/API added), or
    // "carrier" (a permanent-class telephony failure — invalid/dead number).
    reason: text("reason").notNull(),
    // Provenance for the consent/DNC audit trail.
    source: text("source"),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [uniqueIndex("voice_suppressions_phone_idx").on(table.phone)],
);
