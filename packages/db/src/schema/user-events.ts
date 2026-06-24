import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    userId: text("user_id").notNull(),
    event: text("event").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>(),
    // Where the event entered the pipeline: a webhook source id ("posthog",
    // "stripe", …), "api", "studio", a connector id, "journey", etc. Nullable —
    // events ingested before this column existed have no recorded origin.
    source: text("source"),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("user_events_user_id_idx").on(table.userId),
    index("user_events_event_idx").on(table.event),
    index("user_events_source_idx").on(table.source),
    index("user_events_occurred_at_idx").on(table.occurredAt),
    index("user_events_user_event_occurred_idx").on(
      table.userId,
      table.event,
      table.occurredAt,
    ),
    uniqueIndex("user_events_idempotency_key_idx").on(table.idempotencyKey),
  ],
);
