import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cloud } from "./_shared";
import { organizations } from "./organizations";

/**
 * Append-only record of every control-plane mutation: who did what to which
 * subject, with a free-shaped detail payload. Every service mutation writes one
 * (PRD 02 EARS), and `StackService.transition()` writes one per edge.
 *
 * No `updated_at` — rows are never modified.
 */
export const cloudAuditLog = cloud.table(
  "cloud_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Who: a user id, an API key id, or a system actor like "provisioner". */
    actor: text("actor").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** What: a dotted verb, e.g. "stack.transition" / "provider_key.store". */
    action: text("action").notNull(),
    /** To which: the affected row's id or natural key. */
    subject: text("subject").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The audit view: one tenant's history, newest first.
    index("cloud_audit_log_org_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);
