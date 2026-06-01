import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { alertChannelEnum, alertRuleTypeEnum } from "./enums.js";

export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    type: alertRuleTypeEnum("type").notNull(),
    threshold: jsonb("threshold").$type<Record<string, number>>().notNull(),
    channel: alertChannelEnum("channel").notNull(),
    channelConfig: jsonb("channel_config")
      .$type<Record<string, string>>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    lastFiredAt: timestamp("last_fired_at", {
      withTimezone: true,
    }),
    ...timestamps,
  },
  (table) => [
    index("alert_rules_type_idx").on(table.type),
    index("alert_rules_enabled_idx").on(table.enabled),
  ],
);
