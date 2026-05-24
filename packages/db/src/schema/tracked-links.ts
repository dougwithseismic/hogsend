import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { emailSends } from "./email-sends.js";

export const trackedLinks = pgTable("tracked_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  emailSendId: uuid("email_send_id")
    .notNull()
    .references(() => emailSends.id, { onDelete: "cascade" }),
  originalUrl: text("original_url").notNull(),
  clickCount: integer("click_count").notNull().default(0),
  ...timestamps,
});
