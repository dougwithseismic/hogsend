import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { alertRules } from "./alert-rules.js";

export const alertHistory = pgTable(
  "alert_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertRuleId: uuid("alert_rule_id")
      .notNull()
      .references(() => alertRules.id),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    deliveryStatus: text("delivery_status").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (table) => [
    index("alert_history_rule_id_idx").on(table.alertRuleId),
    index("alert_history_created_at_idx").on(table.createdAt),
  ],
);
