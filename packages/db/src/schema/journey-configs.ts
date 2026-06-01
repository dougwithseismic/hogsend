import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const journeyConfigs = pgTable(
  "journey_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: text("journey_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("journey_configs_journey_id_idx").on(table.journeyId),
  ],
);
