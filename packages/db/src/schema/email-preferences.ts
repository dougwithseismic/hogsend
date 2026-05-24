import {
  boolean,
  jsonb,
  pgTable,
  text,
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
    categories: jsonb("categories")
      .$type<Record<string, boolean>>()
      .default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("email_preferences_user_email_idx").on(
      table.userId,
      table.email,
    ),
  ],
);
