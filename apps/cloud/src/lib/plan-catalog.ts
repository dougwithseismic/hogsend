import type { BillingPlan } from "../billing/types";
import type { CloudPlan } from "../services/orgs";

/**
 * The tier table from DECISIONS §2, as the words a customer reads.
 *
 * The NUMBERS a plan enforces live in `PLAN_LIMITS` (`services/billing-plan.ts`)
 * and are not restated here — a page that carried its own copy of "100k events"
 * would eventually disagree with the sweep that suspends ingest at 100k, and the
 * customer would be right and the page wrong. This module carries only what the
 * limits table cannot: a display name and a price.
 */

export interface PlanDisplay {
  label: string;
  /** DECISIONS §2. The recurring price the paid tiers check out against. */
  price: string;
}

export const PLAN_CATALOG = {
  trial: { label: "Trial", price: "free for 14 days" },
  self_serve: { label: "Self-serve", price: "$49/mo" },
  dedicated: { label: "Dedicated", price: "$149/mo" },
} as const satisfies Record<CloudPlan, PlanDisplay>;

/** Paid tiers, cheapest first — the order the upgrade buttons render in. */
const PAID_TIERS: BillingPlan[] = ["self_serve", "dedicated"];

/**
 * The tiers `plan` can move UP to.
 *
 * Upgrades only: a downgrade changes what a running tenant is allowed to have
 * (environments, dedicated infrastructure) and so is not a button — it goes
 * through the provider's own portal, where the customer can also cancel.
 */
export function upgradesFrom(plan: CloudPlan): BillingPlan[] {
  if (plan === "dedicated") return [];
  if (plan === "self_serve") return ["dedicated"];
  return PAID_TIERS;
}
