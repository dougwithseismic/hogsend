import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Your CLIENT-track schema. Engine tables (contacts, journeyStates,
 * emailSends, tracking, ...) live in `@hogsend/db` and migrate on the ENGINE
 * track — do NOT redefine them here. Add only your own app-specific tables.
 *
 * After editing this file:
 *   pnpm db:generate   # writes a new migration into ./migrations
 *   pnpm db:migrate    # applies engine track, then your client track
 *
 * The example below is a starter table; rename or replace it.
 */
export const clientNotes = pgTable("client_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
