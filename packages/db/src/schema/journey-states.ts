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
import { journeyStatusEnum } from "./enums.js";

export const journeyStates = pgTable(
  "journey_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: text("journey_id").notNull(),
    userId: text("user_id").notNull(),
    currentNodeId: text("current_node_id").notNull(),
    status: journeyStatusEnum("status").notNull().default("active"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    waitUntil: timestamp("wait_until", { withTimezone: true }),
    entryCount: integer("entry_count").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("journey_states_journey_user_idx").on(table.journeyId, table.userId),
    index("journey_states_status_idx").on(table.status),
    index("journey_states_wait_until_idx").on(table.waitUntil),
  ],
);
