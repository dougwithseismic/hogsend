import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: text("actor").notNull(),
    actorKeyId: uuid("actor_key_id"),
    action: text("action").notNull(),
    resource: text("resource").notNull(),
    resourceId: text("resource_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    ...timestamps,
  },
  (table) => [
    index("audit_logs_actor_idx").on(table.actor),
    index("audit_logs_resource_idx").on(table.resource, table.resourceId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);
