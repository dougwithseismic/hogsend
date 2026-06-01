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
import { timestamps } from "./_shared.js";
import { journeyStatusEnum } from "./enums.js";

export const journeyStates = pgTable(
  "journey_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email").notNull(),
    journeyId: text("journey_id").notNull(),
    currentNodeId: text("current_node_id").notNull(),
    status: journeyStatusEnum("status").notNull().default("active"),
    hatchetRunId: text("hatchet_run_id"),
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    errorMessage: text("error_message"),
    entryCount: integer("entry_count").notNull().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("uq_user_journey_active").on(
      table.userId,
      table.journeyId,
      table.status,
    ),
    index("journey_states_status_idx").on(table.status),
    index("journey_states_hatchet_run_idx").on(table.hatchetRunId),
    index("journey_states_user_id_idx").on(table.userId),
    index("journey_states_journey_id_status_idx").on(
      table.journeyId,
      table.status,
    ),
  ],
);
