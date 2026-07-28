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
    // PRD 04 D2 — PARTIAL btree on the owning contact; see the twin on
    // user_events for why the predicate is not a barrier to `contact_id = $1`.
    index("email_preferences_contact_id_idx")
      .on(table.contactId)
      .where(sql`contact_id IS NOT NULL`),
  ],
);
