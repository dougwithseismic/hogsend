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
  /**
   * Hogsend Email: do sends above `emailsPerMonth` bill as metered overage, or
   * does sending simply stop there? (PRD 09.)
   *
   * False on `trial` deliberately — a trial has no payment method on file, so
   * "overage" would be an invoice nobody agreed to.
   */
  emailOverage: boolean;
  /**
   * Hogsend Email: the absolute ceiling for one billing period. Sending STOPS
   * here, overage or not.
   *
   * The cap is an abuse control before it is a billing one. A compromised
   * tenant token that bills forty thousand dollars of overage is not a success
   * case, and there is no amount of revenue that makes an unbounded meter on
   * OUR AWS account a good idea. Equal to the allowance on plans with no
   * overage, ten times it on plans with.
   */
  emailHardCap: number;
}

/**
 * When a tenant is told they are approaching the ceiling, as whole percents of
 * the INCLUDED allowance.
 *
 * Percents rather than fractions because the notify-once ledger keys on this
 * number, and an integer in a unique index cannot drift the way `0.1 + 0.7`
 * can. 80 is far enough ahead to act on; 100 is the moment the included
 * allowance is gone and either overage or a stop begins.
 */
export const EMAIL_ALLOWANCE_WARNING_PERCENTS = [80, 100] as const;

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
    // No card on file, so nothing to bill: the allowance IS the cap.
    emailOverage: false,
    emailHardCap: 1_000,
  },
  self_serve: {
    environments: PLAN_ENVIRONMENT_LIMITS.self_serve,
    eventsPerMonth: 100_000,
    emailsPerMonth: 10_000,
    emailOverage: true,
    emailHardCap: 100_000,
  },
  dedicated: {
    environments: PLAN_ENVIRONMENT_LIMITS.dedicated,
    eventsPerMonth: 1_000_000,
    emailsPerMonth: 100_000,
    emailOverage: true,
    emailHardCap: 1_000_000,
  },
} as const satisfies Record<CloudPlan, PlanLimits>;

export function planLimits(plan: CloudPlan): PlanLimits {
  return PLAN_LIMITS[plan];
}
