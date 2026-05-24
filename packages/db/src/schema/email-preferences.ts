import {
  boolean,
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
  ],
);
