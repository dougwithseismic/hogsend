import { sql } from "drizzle-orm";
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
    // EXACTLY ONE LIVE enrollment per (user, journey) — a PARTIAL unique index
    // scoped to non-terminal rows (status IN ('active','waiting')), mirroring
    // uq_user_bucket_active. The old FULL (user,journey,status) index broke
    // `unlimited` journeys: the 2nd completion produced a second
    // (user,journey,'completed') row and threw 23505. Terminal rows
    // (completed/failed/exited) sit OUTSIDE the predicate, so an unlimited journey
    // can complete any number of times (one row per completion — every reader
    // counts rows, never the dead entry_count column). The predicate matches the
    // enrollment guard's live set (define-journey.ts:133-142) and checkExits, and
    // is a STRICTLY tighter backstop than the old index (it also blocks a
    // concurrent active+waiting double-insert). Generated SQL: `CREATE UNIQUE
    // INDEX uq_user_journey_active ON journey_states (user_id, journey_id)
    // WHERE status IN ('active','waiting')`.
    //
    // organizationId deliberately OMITTED — same NULLS-DISTINCT caveat as
    // uq_user_bucket_active. When multi-tenancy lands and the column is non-null,
    // add it to the PREDICATE (not the indexed columns).
    uniqueIndex("uq_user_journey_active")
      .on(table.userId, table.journeyId)
      .where(sql`status IN ('active', 'waiting')`),
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
