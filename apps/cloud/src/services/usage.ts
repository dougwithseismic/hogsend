import { and, eq, inArray } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  environments,
  organizations,
  stacks,
  usageCounters,
} from "../db/schema";
import { NotFoundError } from "./errors";
import type { CloudPlan, EnvironmentRow, StackRow } from "./orgs";
import { type PlanLimits, planLimits } from "./plan-limits";

/**
 * The metered side of a tenant: the `usage_counters` sink, and the one read the
 * Usage page and the overage banner are both built from.
 *
 * Three decisions worth stating:
 *
 *  - **A counter row is a UTC CALENDAR MONTH, keyed `YYYY-MM`.** Not a rolling
 *    30 days and not the tenant's local month: the cap resets on a date every
 *    party can name in advance, and "used 40k of 100k events" means the same
 *    thing to the dashboard, the sweep and an invoice.
 *  - **The BILLING WINDOW is per plan, and is not always one month.** A paid
 *    plan is billed by the calendar month, so its window is exactly the current
 *    row. A trial is sold as "10k events + 1k emails TOTAL for 14 days"
 *    (DECISIONS §2), so its window is every month the trial has touched — a
 *    trial that starts on the 20th would otherwise be handed a second, free
 *    allowance on the 1st, which is roughly half of all trials.
 *  - **The sweep SETS the counter, it does not add to it.** `usage_counters`
 *    was scaffolded (PRD 02) as an upsert-INCREMENT sink for a stream of
 *    deltas; the source that actually landed is a periodic absolute count from
 *    the tenant database, and an absolute source must be written absolutely. A
 *    sweep that ran twice in a night — a retry, an operator re-run — would
 *    otherwise double a tenant's month and suspend their ingest for it.
 */

const DAY_MS = 86_400_000;

/** The `YYYY-MM` (UTC) key for the period `at` falls in. */
export function usageMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export interface UsagePeriod {
  /** `YYYY-MM`, the `usage_counters.month` key. */
  month: string;
  /** Inclusive start, UTC midnight on the 1st. */
  since: Date;
  /** Exclusive end — the next month's `since`. */
  until: Date;
}

/** The UTC calendar month containing `at`, as a half-open window. */
export function usagePeriod(at: Date): UsagePeriod {
  const since = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const until = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { month: usageMonth(since), since, until };
}

/**
 * A trial lasts 14 days, so its window can straddle exactly ONE month boundary.
 * The lookback is clamped to that so a stale `trial` row — an org whose expiry
 * sweep never ran — can never make the window walk a tenant's whole history.
 */
const TRIAL_LOOKBACK_MS = 45 * DAY_MS;

export interface BillingWindow {
  /** Every `YYYY-MM` counted, oldest first. Always ends with the current one. */
  months: string[];
  /** The current month — what the dashboard names as "this period". */
  current: string;
}

/**
 * The months a plan's cap is measured over.
 *
 * Paid plans: the current calendar month, and only it. Trial: every month the
 * trial has touched, because the trial's cap is a TOTAL for the whole 14 days
 * (DECISIONS §2) rather than a monthly allowance.
 */
export function billingWindow(
  organization: { plan: CloudPlan; createdAt: Date },
  now: Date,
): BillingWindow {
  const current = usageMonth(now);
  if (organization.plan !== "trial") return { months: [current], current };

  // Clamped at both ends: never further back than a trial can reach, and never
  // FORWARD of `now` — the window must always contain the current month, which
  // is the one the meter is writing into.
  const start = Math.min(
    Math.max(
      organization.createdAt.getTime(),
      now.getTime() - TRIAL_LOOKBACK_MS,
    ),
    now.getTime(),
  );
  return { months: monthsBetween(new Date(start), now), current };
}

/** Every `YYYY-MM` from `since` to `until` inclusive, oldest first. */
function monthsBetween(since: Date, until: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1),
  );
  const last = usageMonth(until);
  for (;;) {
    const month = usageMonth(cursor);
    months.push(month);
    if (month >= last) return months;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

export interface UpsertUsageCounterInput {
  organizationId: string;
  environmentId: string;
  month: string;
  events: number;
  emails: number;
  now?: Date;
}

/**
 * Record what one environment used in one period. Idempotent by construction:
 * a re-run of the same sweep writes the same absolute numbers.
 */
export async function upsertUsageCounter(
  input: UpsertUsageCounterInput,
  database: CloudDb = defaultDb,
): Promise<void> {
  const updatedAt = input.now ?? new Date();
  await database
    .insert(usageCounters)
    .values({
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      month: input.month,
      eventsCount: input.events,
      emailsCount: input.emails,
    })
    .onConflictDoUpdate({
      target: [usageCounters.environmentId, usageCounters.month],
      set: {
        eventsCount: input.events,
        emailsCount: input.emails,
        updatedAt,
      },
    });
}

export interface EnvironmentUsage {
  environmentId: string;
  name: string;
  kind: EnvironmentRow["kind"];
  /** Null when the environment has no stack row at all. */
  stackId: string | null;
  stackStatus: StackRow["status"] | null;
  /** Set when plan enforcement paused ingest on this stack. */
  ingestSuspendedAt: Date | null;
  events: number;
  emails: number;
}

export interface UsageView {
  organizationId: string;
  plan: CloudPlan;
  limits: PlanLimits;
  /** The current `YYYY-MM`. */
  month: string;
  /** Every month the totals below cover — one, except on a trial. */
  months: string[];
  environments: EnvironmentUsage[];
  /**
   * The billed totals: EVERY environment, summed over the billing window.
   *
   * Not production-only. A cap that ignored staging would be a plan
   * enforcement bypass anyone could reach with one SDK base-URL change, and
   * DECISIONS §2 sells the extra environments as part of the tier rather than
   * as extra allowance. The per-environment breakdown below is what shows
   * where the usage came from.
   */
  totalEvents: number;
  totalEmails: number;
  overEvents: boolean;
  overEmails: boolean;
  /** True when any of this org's stacks currently has ingest paused. */
  ingestSuspended: boolean;
  trialEndsAt: Date | null;
  /** Whole days from `now` to `trialEndsAt`, floored at 0. Null off trial. */
  trialDaysLeft: number | null;
  /** Set once a checkout completed — what "Manage billing" opens. */
  billingCustomerId: string | null;
}

/**
 * Everything the Usage page and the overage banner render, in one read.
 *
 * A LEFT join on `usage_counters`, so an environment that has never been swept
 * reads as zero rather than vanishing from the list — "no counter yet" and "no
 * environment" are different facts and the page says so.
 */
export async function readUsageView(
  input: { organizationId: string; now?: Date },
  database: CloudDb = defaultDb,
): Promise<UsageView> {
  const now = input.now ?? new Date();

  const [organization] = await database
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!organization) {
    throw new NotFoundError("Organization", input.organizationId);
  }

  const { months, current } = billingWindow(organization, now);

  const rows = await database
    .select({
      environmentId: environments.id,
      name: environments.name,
      kind: environments.kind,
      stackId: stacks.id,
      stackStatus: stacks.status,
      ingestSuspendedAt: stacks.ingestSuspendedAt,
      events: usageCounters.eventsCount,
      emails: usageCounters.emailsCount,
    })
    .from(environments)
    .leftJoin(stacks, eq(stacks.environmentId, environments.id))
    .leftJoin(
      usageCounters,
      and(
        eq(usageCounters.environmentId, environments.id),
        inArray(usageCounters.month, months),
      ),
    )
    .where(eq(environments.organizationId, input.organizationId))
    .orderBy(environments.name);

  // One row per environment PER MONTH in the window, so the months are folded
  // back together here: the page lists environments, not (environment, month)
  // pairs, and the totals are the window's.
  const byEnvironment = new Map<string, EnvironmentUsage>();
  for (const row of rows) {
    const existing = byEnvironment.get(row.environmentId);
    if (existing) {
      existing.events += row.events ?? 0;
      existing.emails += row.emails ?? 0;
      continue;
    }
    byEnvironment.set(row.environmentId, {
      environmentId: row.environmentId,
      name: row.name,
      kind: row.kind,
      stackId: row.stackId,
      stackStatus: row.stackStatus,
      ingestSuspendedAt: row.ingestSuspendedAt,
      events: row.events ?? 0,
      emails: row.emails ?? 0,
    });
  }
  const list = [...byEnvironment.values()];

  const totalEvents = sum(list.map((row) => row.events));
  const totalEmails = sum(list.map((row) => row.emails));
  const limits = planLimits(organization.plan);

  return {
    organizationId: organization.id,
    plan: organization.plan,
    limits,
    month: current,
    months,
    environments: list,
    totalEvents,
    totalEmails,
    overEvents: totalEvents > limits.eventsPerMonth,
    overEmails: totalEmails > limits.emailsPerMonth,
    ingestSuspended: list.some((row) => row.ingestSuspendedAt !== null),
    trialEndsAt: organization.trialEndsAt,
    trialDaysLeft: trialDaysLeft(organization.trialEndsAt, now),
    billingCustomerId: organization.billingCustomerId,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Floored at zero: an expired trial has no days left, never negative ones. */
function trialDaysLeft(trialEndsAt: Date | null, now: Date): number | null {
  if (!trialEndsAt) return null;
  return Math.max(
    0,
    Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS),
  );
}
