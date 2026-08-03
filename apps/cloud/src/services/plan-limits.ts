import { type CloudPlan, PLAN_ENVIRONMENT_LIMITS } from "./orgs";

/**
 * DECISIONS §2, as data.
 *
 * Its own module rather than a section of `billing-plan.ts` because BOTH sides
 * of the billing loop read it: the plan service (what a webhook may change) and
 * the metering enforcement (what a meter is judged against). With the table
 * living in the plan service, enforcement would have to import the plan service
 * and the plan service would have to import enforcement to reconcile a flag on
 * an upgrade — a cycle around a constant.
 */

export interface PlanLimits {
  /** Environments, including production. */
  environments: number;
  /**
   * Ingested events per billing period, summed across EVERY environment. For
   * `trial` the period is the whole 14-day trial rather than a calendar month —
   * see `billingWindow` in `services/usage.ts`, which is what both the meter
   * and the dashboard measure against this number.
   */
  eventsPerMonth: number;
  /** Emails sent per billing period; same trial caveat as `eventsPerMonth`. */
  emailsPerMonth: number;
}

/**
 * The tier table from DECISIONS §2. The environment counts are NOT restated
 * here — they are read off `PLAN_ENVIRONMENT_LIMITS`, which the environment
 * service already enforces, so the two can never drift into disagreeing about
 * what a plan allows.
 */
export const PLAN_LIMITS = {
  trial: {
    environments: PLAN_ENVIRONMENT_LIMITS.trial,
    eventsPerMonth: 10_000,
    emailsPerMonth: 1_000,
  },
  self_serve: {
    environments: PLAN_ENVIRONMENT_LIMITS.self_serve,
    eventsPerMonth: 100_000,
    emailsPerMonth: 10_000,
  },
  dedicated: {
    environments: PLAN_ENVIRONMENT_LIMITS.dedicated,
    eventsPerMonth: 1_000_000,
    emailsPerMonth: 100_000,
  },
} as const satisfies Record<CloudPlan, PlanLimits>;

export function planLimits(plan: CloudPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}
