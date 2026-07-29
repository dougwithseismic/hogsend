import { sql } from "drizzle-orm";
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
    /**
     * WHY the tenant is suspended — `billing` for a cancellation or an expired
     * dunning grace, anything else (today: null) for an ops/abuse stop. Cleared
     * with the suspension itself.
     *
     * It exists because a suspension has to be REVERSIBLE by exactly the party
     * that caused it: a tenant who re-subscribes must come back automatically,
     * and an abuse stop must not be liftable by paying an invoice. Without a
     * reason the two are the same row and one of those rules has to break.
     */
    suspendedReason: text("suspended_reason"),
    /** now + 14d at creation for `trial`. */
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    /**
     * When the FIRST failed payment landed; null = in good standing (PRD 06).
     * The 14-day grace is measured from this instant, so a later failure must
     * never overwrite it — a retry that restarted the clock would let a
     * non-paying tenant run forever.
     */
    dunningSince: timestamp("dunning_since", { withTimezone: true }),
    /**
     * The billing provider's customer handle, recorded from the first completed
     * checkout. OPAQUE to everything except the provider that issued it — it is
     * what `getPortalUrl` opens a self-serve management session against.
     */
    billingCustomerId: text("billing_customer_id"),
    ...timestamps,
  },
  (table) => [
    // "what is on this cell" — placement counts and cell drains.
    index("organizations_cell_id_idx").on(table.cellId),
    // Billing sweeps: expiring trials, plan rollups.
    index("organizations_plan_idx").on(table.plan),
    // The dunning sweep reads ONLY the orgs with a running grace clock, which
    // is a tiny minority — a partial index keeps that scan proportional to the
    // problem rather than to the tenant count.
    index("organizations_dunning_since_idx")
      .on(table.dunningSince)
      .where(sql`${table.dunningSince} is not null`),
  ],
);
