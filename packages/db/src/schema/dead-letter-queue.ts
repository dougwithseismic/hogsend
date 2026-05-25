import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { dlqStatusEnum } from "./enums.js";

export const deadLetterQueue = pgTable(
  "dead_letter_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    sourceId: text("source_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    error: text("error").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    status: dlqStatusEnum("status").notNull().default("pending"),
    retriedAt: timestamp("retried_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("dlq_source_idx").on(table.source),
    index("dlq_status_idx").on(table.status),
    index("dlq_created_at_idx").on(table.createdAt),
  ],
);
