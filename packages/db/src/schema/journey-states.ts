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
    organizationId: text("organization_id"),
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
    // NOTE: organizationId is intentionally NOT in this unique index yet. It is
    // nullable (single-tenant today), and Postgres treats NULLs as DISTINCT in a
    // unique index by default — so adding it now would silently stop enforcing
    // one-active-journey-per-user for all existing rows. drizzle 0.45.2's
    // uniqueIndex() can't express NULLS NOT DISTINCT. When multi-tenancy lands and
    // organizationId is non-null, add it to this key (a cheap rebuild on this
    // modest table). The nullable column is added now (the real cheap insurance).
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
    // Time-windowed activity counts (GET /v1/health) range-scan on updatedAt —
    // without this the healthcheck seq-scans the whole table on every hit.
    index("journey_states_updated_at_idx").on(table.updatedAt),
  ],
);
