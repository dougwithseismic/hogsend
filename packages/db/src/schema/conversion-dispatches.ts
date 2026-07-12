import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { conversions } from "./conversions.js";

/**
 * Conversion dispatch log (docs/revenue-attribution-plan.md §5.2) — one row
 * per (fired conversion, destination). `event_id` is the deterministic dedup
 * id resent verbatim on every retry; the unique (destination, event_id) pair
 * means a re-evaluated ingest or a re-enqueued task never double-creates a
 * dispatch. Status transitions: pending → delivered | failed (after the
 * durable task exhausts retries).
 */
export const conversionDispatches = pgTable(
  "conversion_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversionId: uuid("conversion_id")
      .notNull()
      .references(() => conversions.id, { onDelete: "cascade" }),
    destinationId: text("destination_id").notNull(),
    eventId: text("event_id").notNull(),
    status: text("status", {
      enum: ["pending", "delivered", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("conversion_dispatches_destination_event_idx").on(
      table.destinationId,
      table.eventId,
    ),
    index("conversion_dispatches_status_idx").on(table.status),
  ],
);
