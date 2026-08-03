import { boolean, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cloud } from "./_shared";
import { organizations } from "./organizations";
import { stacks } from "./stacks";

/**
 * One health observation of one stack — the health poll's append-only trail.
 *
 * Deliberately a LOG rather than a column on `stacks`:
 *  - the alert rule (PRD 04 EARS: "unhealthy 3 consecutive sweeps") is a
 *    statement about a SEQUENCE, and a single `healthy` boolean cannot answer
 *    it. Keeping the observations is what makes "3 in a row" a query instead of
 *    a counter that has to be maintained correctly on every path;
 *  - there is NO alert table on purpose. An alert is derived from these rows on
 *    read (`getStackAlerts`), so it can never go stale relative to them;
 *  - the sweep NEVER transitions a stack. A `running` stack that is sick is
 *    still `running` — a poll is an observation, not an operator decision.
 *
 * `checked_at` is written by the sweep (not `defaultNow()`) so the row records
 * when the substrate was ASKED, and so a test can drive the clock.
 */
export const stackHealth = cloud.table(
  "stack_health",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    // Denormalised like `stacks.organization_id`: every tenant-scoped read
    // filters by org, and a health read must not need a join to be safe.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    healthy: boolean("healthy").notNull(),
    /** Free-form reason. Present when unhealthy; never carries a secret. */
    detail: text("detail"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // THE access path: "the most recent N observations for this stack",
    // which is exactly what the streak rule reads.
    index("stack_health_stack_id_checked_at_idx").on(
      table.stackId,
      table.checkedAt,
    ),
  ],
);
