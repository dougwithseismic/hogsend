import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trackedLinks } from "./tracked-links.js";

export const linkClicks = pgTable(
  "link_clicks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackedLinkId: uuid("tracked_link_id")
      .notNull()
      .references(() => trackedLinks.id, { onDelete: "cascade" }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    clickedAt: timestamp("clicked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("link_clicks_tracked_link_id_idx").on(table.trackedLinkId)],
);
