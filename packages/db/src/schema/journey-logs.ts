import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { journeyStates } from "./journey-states.js";

export const journeyLogs = pgTable("journey_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  journeyStateId: uuid("journey_state_id")
    .notNull()
    .references(() => journeyStates.id, { onDelete: "cascade" }),
  fromNodeId: text("from_node_id"),
  toNodeId: text("to_node_id"),
  action: text("action").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  ...timestamps,
});
