import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { cells } from "./cells";
import { cloudPlanEnum, cloudRegionEnum } from "./enums";

/**
 * Mirror of the Better Auth organization — the tenant root. The primary key is
 * Better Auth's own organization id (text), NOT a fresh uuid, so every
 * tenant-scoped row can be joined straight from a session without a lookup
 * table and the two stores can never drift out of correspondence.
 */
export const organizations = cloud.table(
  "organizations",
  {
    /** Better Auth organization id — the single tenant identifier. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Data residency; fixed at creation. */
    region: cloudRegionEnum("region").notNull(),
    plan: cloudPlanEnum("plan").default("trial").notNull(),
    /**
     * Placement on a shared cell. NULL for `dedicated` plans, which get their
     * own substrate rather than a slot on shared infrastructure.
     */
    cellId: uuid("cell_id").references(() => cells.id, {
      onDelete: "set null",
    }),
    /** Set when billing/ops suspends the tenant; null = active. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** now + 14d at creation for `trial`. */
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // "what is on this cell" — placement counts and cell drains.
    index("organizations_cell_id_idx").on(table.cellId),
    // Billing sweeps: expiring trials, plan rollups.
    index("organizations_plan_idx").on(table.plan),
  ],
);
