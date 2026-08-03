import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { organizations } from "./organizations";
import { stacks } from "./stacks";

/**
 * What the operator has already been told, per stack and per condition.
 *
 * This is the ONE stateful table in the alerting path, and it exists for a
 * single reason: an alert that repeats every tick is worse than no alert,
 * because it trains the one person who can fix things to ignore the channel.
 * The conditions the alert sweep watches match PERSISTENTLY — a stack that is
 * `running` with no minted credentials matches on every tick until T2 ships,
 * and a stack past the provision attempt ceiling matches until a human touches
 * it. So the sweep has to remember, and the memory has to outlive the process:
 * an in-memory set resets on every worker deploy, which on Railway is often,
 * and would reintroduce exactly the storm this table prevents.
 *
 * Deliberately a CURRENT-STATE row per (stack, condition) rather than an
 * append-only log. The question the sweep asks is "have I already said this,
 * and is it still the same thing I said?" — one row answers it with a primary
 * key lookup, whereas a log would answer it with a windowed aggregate that has
 * to be kept correct as the cooldown changes.
 *
 * Contrast `stack_health`, which IS a log: its rule ("unhealthy 3 consecutive
 * sweeps") is a statement about a sequence, so the sequence has to be kept.
 * This rule is a statement about the LAST thing said, so only that is kept.
 */
export const stackAlerts = cloud.table(
  "stack_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stackId: uuid("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    // Denormalised like `stack_health.organization_id`: an operator reading
    // alerts wants the tenant, and that read must not need a join.
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Which rule fired. Plain text rather than a Postgres enum: the conditions
     * are the sweep's own vocabulary and will grow, and a new one must not need
     * a migration to be alertable.
     */
    condition: text("condition").notNull(),
    /**
     * A short signature of WHAT was said — the stack status, the attempt count.
     *
     * It is what makes "the condition changed" distinguishable from "the
     * condition persists". A stack that was `provisioning` for 40 minutes and
     * is now `error` is new information at 2am even though the general
     * non-running rule matched both times; a stack that has simply stayed
     * `error` is not.
     */
    fingerprint: text("fingerprint").notNull(),
    /** When the operator was last told. The cooldown is measured from here. */
    lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * When the sweep observed the condition no longer matching; null while it
     * still does.
     *
     * Recorded rather than deleted so a recurrence is legible in the row it
     * reuses, and — the operative reason — so a condition that clears and comes
     * back ALERTS AGAIN instead of being suppressed by a stale record that
     * happens to be inside the cooldown.
     */
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // The dedupe key, and the only access path: one memory per rule per stack.
    uniqueIndex("stack_alerts_stack_id_condition_unique_idx").on(
      table.stackId,
      table.condition,
    ),
  ],
);
