import { sql } from "drizzle-orm";
import {
  boolean,
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

export const emailPreferences = pgTable(
  "email_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // PRD 05 F5: the key AS OBSERVED AT WRITE TIME — frozen, never rewritten.
    // Ownership rides contact_id; reads scope by it (bySubject).
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    // Owning contact, dual-written by the engine (PRD 04). NOTHING reads this
    // column yet; no FK by design — see PRD 04 D1. Indexed partially below.
    contactId: uuid("contact_id"),
    unsubscribedAll: boolean("unsubscribed_all").notNull().default(false),
    suppressed: boolean("suppressed").notNull().default(false),
    bounceCount: integer("bounce_count").notNull().default(0),
    categories: jsonb("categories")
      .$type<Record<string, boolean>>()
      .default({}),
    suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
    lastBounceAt: timestamp("last_bounce_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("email_preferences_user_email_idx").on(
      table.userId,
      table.email,
    ),
    // PRD 05 T3 — the CONTACT-scoped twin of email_preferences_user_email_idx.
    // Adoption stamps `contact_id` WITHOUT rewriting `user_id`, so one contact
    // can end up with TWO preference rows for the SAME address under two string
    // keys. That is the worst duplicate on this table: a `contact_id` read that
    // picks the stale row mails someone who unsubscribed.
    //
    // `contact_id IS NOT NULL` in the predicate is LOAD-BEARING: a preference
    // write whose contact resolve returned nothing (D6 degrades to NULL) is
    // legal and permanent, so those rows must stay outside this index and keep
    // getting their uniqueness from the string index above.
    //
    // NOTHING targets this as an ON CONFLICT arbiter (drizzle can only target
    // columns, and a bare (contact_id, email) arbiter would never fire for the
    // NULL population). Both writers — `upsertEmailPreference` and the admin
    // preferences route — keep the (user_id, email) arbiter and CATCH this
    // index's 23505, converting it into an UPDATE of the contact's existing row.
    uniqueIndex("email_preferences_contact_email_idx")
      .on(table.contactId, table.email)
      .where(sql`contact_id IS NOT NULL`),
    // PRD 04 D2 — PARTIAL btree on the owning contact; see the twin on
    // user_events for why the predicate is not a barrier to `contact_id = $1`.
    index("email_preferences_contact_id_idx")
      .on(table.contactId)
      .where(sql`contact_id IS NOT NULL`),
  ],
);
