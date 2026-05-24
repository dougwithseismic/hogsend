import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    event: text("event").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("user_events_user_id_idx").on(table.userId),
    index("user_events_event_idx").on(table.event),
    index("user_events_occurred_at_idx").on(table.occurredAt),
  ],
);
