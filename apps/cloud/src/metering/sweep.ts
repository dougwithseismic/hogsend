import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { organizations, stacks } from "../db/schema";
import { decryptSecretPayload } from "../lib/crypto";
import { suspendStack } from "../pipeline/lifecycle";
import { writeAudit } from "../services/audit";
import {
  type EnforceDunningResult,
  PlanService,
} from "../services/billing-plan";
import { OrgService, type StackRow } from "../services/orgs";
import {
  type UsagePeriod,
  upsertUsageCounter,
  usagePeriod,
} from "../services/usage";
import { getSubstrate, type SubstrateProvider } from "../substrate";
import {
  ENFORCEMENT_FAILED_ACTION,
  type EnforcementAction,
  METERING_ACTOR,
  reasonOf,
  reconcileOrganization,
  type StackFailure,
} from "./enforcement";
import {
  type ReconcileOverageResult,
  type ReportOverageResult,
  reconcileEmailOverage,
  reportEmailOverage,
  type WarnAllowanceResult,
  warnEmailAllowance,
} from "./overage";
import {
  readTenantUsage as defaultReadTenantUsage,
  type TenantUsageReader,
} from "./tenant-usage";

/**
 * The nightly billing sweep: meter every tenant, then enforce what the meter
 * says.
 *
 * The laws, in the order they matter:
 *
 *  - **One dead tenant never stops the fleet.** Every per-stack and per-org step
 *    is wrapped: a failure is recorded (an audit row plus an entry in the
 *    result) and the sweep moves to the next tenant. The alternative is a single
 *    unreachable database blinding the control plane to every other customer's
 *    usage — and, because enforcement reads the meter, silently freezing
 *    everyone's caps at whatever they were the night it broke.
 *  - **Metering never writes to a tenant database.** Enforced in
 *    `tenant-usage.ts` by a read-only session, not by convention here.
 *  - **A month gets CLOSED.** The cron runs at 03:00, so the last sweep of a
 *    month would otherwise leave its counter reflecting usage only up to
 *    03:00 on the last day — the final 21 hours never billed, and an org that
 *    crossed its cap inside them never suspended for it. Within 48h of a
 *    boundary the sweep meters the PREVIOUS period as well; the counter write
 *    is absolute, so re-closing a month is a no-op the second time.
 *  - **The cap counts every environment**, and enforcement itself lives in
 *    `metering/enforcement.ts` because a plan change has to reach the same code
 *    without waiting for tomorrow's cron.
 *  - **A suspension is soft.** Ingest returns 429 (`HOGSEND_INGEST_SUSPENDED`,
 *    DECISIONS §2); nothing is deleted, no already-accepted event is lost, and
 *    the stack keeps running so the tenant's dashboard, sends and journeys are
 *    untouched. Trial EXPIRY is the harder stop — the stack is suspended — and
 *    is the only thing here that stops a tenant's instance.
 */

/** 03:00 UTC daily: after most timezones' midnight roll, well clear of it. */
export const BILLING_SWEEP_CRON = "0 3 * * *";

export type {
  EnforcementAction,
  EnforcementVerdict,
} from "./enforcement";
export {
  ENFORCEMENT_FAILED_ACTION,
  INGEST_RESUMED_ACTION,
  INGEST_SUSPENDED_ACTION,
  INGEST_SUSPENDED_ENV,
  METERING_ACTOR,
} from "./enforcement";

export const USAGE_SWEEP_FAILED_ACTION = "usage.sweep_failed";
export const TRIAL_EXPIRED_ACTION = "billing.trial_expired";

/**
 * How close to a month boundary the sweep also re-closes the previous period.
 * Two days: comfortably more than the 24h between two crons, so a single missed
 * run cannot leave a month permanently short.
 */
export const CLOSE_PREVIOUS_PERIOD_MS = 48 * 60 * 60 * 1_000;

export interface MeteringDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  /** Injected so tests meter without a tenant database. */
  readTenantUsage: TenantUsageReader;
  now: () => Date;
}

function defaultDeps(): MeteringDeps {
  return {
    db: defaultDb,
    // Resolved per run, like every other pipeline: a misconfigured railway
    // substrate must fail THIS sweep, not the import of any module near it.
    substrate: getSubstrate(),
    readTenantUsage: defaultReadTenantUsage,
    now: () => new Date(),
  };
}

function resolve(overrides: Partial<MeteringDeps>): MeteringDeps {
  return { ...defaultDeps(), ...overrides };
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

export interface StackUsage {
  stackId: string;
  organizationId: string;
  environmentId: string;
  /** The `YYYY-MM` this counter was written under. */
  month: string;
  events: number;
  emails: number;
}

export type StackSweepFailure = StackFailure;

export interface UsageSweepResult {
  /** The CURRENT `YYYY-MM` — the period enforcement is about to judge. */
  month: string;
  /** Every period metered this run, current first. */
  months: string[];
  /** Counter rows written (a stack near a month boundary contributes two). */
  swept: number;
  counters: StackUsage[];
  failed: StackSweepFailure[];
}

/**
 * The periods one run meters: the current one, plus the previous one while the
 * boundary is still fresh (see the module note). Current FIRST — a failure on
 * one stack stops that stack's remaining periods, and the period enforcement
 * reads must never be the one that got skipped.
 */
export function sweepPeriods(now: Date): UsagePeriod[] {
  const current = usagePeriod(now);
  if (now.getTime() - current.since.getTime() >= CLOSE_PREVIOUS_PERIOD_MS) {
    return [current];
  }
  return [current, usagePeriod(new Date(current.since.getTime() - 1))];
}

/**
 * Meter every RUNNING stack.
 *
 * Exported for direct invocation as well as registered as a Hatchet cron: dev
 * (no Hatchet) and tests call this function, production calls the same function
 * through the durable task, and there is one implementation either way.
 */
export async function sweepUsage(
  overrides: Partial<MeteringDeps> = {},
): Promise<UsageSweepResult> {
  const deps = resolve(overrides);
  const periods = sweepPeriods(deps.now());

  const running = await deps.db
    .select()
    .from(stacks)
    .where(eq(stacks.status, "running"));

  const counters: StackUsage[] = [];
  const failed: StackSweepFailure[] = [];

  for (const stack of running) {
    for (const period of periods) {
      try {
        counters.push(await meterStack(deps, stack, period));
      } catch (error) {
        const reason = reasonOf(error);
        failed.push({
          stackId: stack.id,
          organizationId: stack.organizationId,
          reason,
        });
        // Recorded against the tenant, because an un-metered month is a fact
        // about THEIR bill and an operator has to be able to find it later.
        await writeAudit(deps.db, {
          actor: METERING_ACTOR,
          organizationId: stack.organizationId,
          action: USAGE_SWEEP_FAILED_ACTION,
          subject: stack.id,
          detail: { month: period.month, reason },
        }).catch(() => undefined);
        // The remaining periods share this stack's tenant database, and so
        // share the reason it just failed. One row per failure, not two.
        break;
      }
    }
  }

  const [current] = periods;
  return {
    month: current?.month ?? "",
    months: periods.map((period) => period.month),
    swept: counters.length,
    counters,
    failed,
  };
}

/** Meter one stack for one period. Throws; the caller records and steps over. */
async function meterStack(
  deps: MeteringDeps,
  stack: StackRow,
  period: UsagePeriod,
): Promise<StackUsage> {
  if (!stack.dbDsnEncrypted) {
    // A running stack with no persisted tenant DSN cannot be metered at all —
    // and unlike a network blip, waiting will not fix it.
    throw new Error("stack has no stored tenant DSN");
  }
  const dsn = decryptSecretPayload<string>(stack.dbDsnEncrypted);

  const counts = await deps.readTenantUsage({
    dsn,
    since: period.since,
    until: period.until,
  });

  await upsertUsageCounter(
    {
      organizationId: stack.organizationId,
      environmentId: stack.environmentId,
      month: period.month,
      events: counts.events,
      emails: counts.emails,
      now: deps.now(),
    },
    deps.db,
  );

  return {
    stackId: stack.id,
    organizationId: stack.organizationId,
    environmentId: stack.environmentId,
    month: period.month,
    events: counts.events,
    emails: counts.emails,
  };
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export interface TrialExpiry {
  organizationId: string;
  /** The stacks stopped by the expiry, in the order they were stopped. */
  stackIds: string[];
}

export interface EnforcementResult {
  month: string;
  /** Organizations evaluated (a suspended org is skipped, not evaluated). */
  evaluated: number;
  actions: EnforcementAction[];
  trialsExpired: TrialExpiry[];
  failed: StackSweepFailure[];
}

/**
 * Compare each organization's usage against its plan and make the ingest flag
 * agree with the answer — the fleet loop around `reconcileOrganization`.
 */
export async function enforcePlanLimits(
  overrides: Partial<MeteringDeps> = {},
): Promise<EnforcementResult> {
  const deps = resolve(overrides);
  const now = deps.now();
  const { month } = usagePeriod(now);

  const trialsExpired = await expireTrials(deps, now);
  const expiredIds = new Set(trialsExpired.map((row) => row.organizationId));

  const orgRows = await deps.db.select().from(organizations);

  const actions: EnforcementAction[] = [];
  const failed: StackSweepFailure[] = [];
  let evaluated = 0;

  for (const org of orgRows) {
    if (expiredIds.has(org.id)) continue;
    const result = await reconcileOrganization(
      { db: deps.db, substrate: deps.substrate, now: deps.now },
      org,
    );
    if (result.evaluated) evaluated += 1;
    actions.push(...result.actions);
    failed.push(...result.failed);
  }

  return { month, evaluated, actions, trialsExpired, failed };
}

/**
 * Stop every organization whose trial window has closed.
 *
 * The stacks go first and the org second, so a substrate failure leaves a
 * tenant that is honestly still running rather than an org marked suspended
 * over an instance that is still serving traffic.
 *
 * `reason: "billing"` is load-bearing: it is the ONLY reason `PlanService
 * .recover()` lifts on its own, and that recovery RESUMES the stacks stopped
 * here — so a later checkout brings the tenant back without an operator in the
 * loop.
 */
async function expireTrials(
  deps: MeteringDeps,
  now: Date,
): Promise<TrialExpiry[]> {
  const expired = await deps.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.plan, "trial"),
        isNotNull(organizations.trialEndsAt),
        lte(organizations.trialEndsAt, now),
        // Already stopped is done: re-suspending would move `suspended_at`
        // forward and write a second audit row every night.
        isNull(organizations.suspendedAt),
      ),
    );

  const orgService = new OrgService(deps.db);
  const results: TrialExpiry[] = [];

  for (const { id } of expired) {
    const stackIds: string[] = [];
    try {
      const running = await deps.db
        .select({ id: stacks.id })
        .from(stacks)
        .where(
          and(eq(stacks.organizationId, id), eq(stacks.status, "running")),
        );

      for (const stack of running) {
        await suspendStack(
          { stackId: stack.id },
          { db: deps.db, substrate: deps.substrate },
        );
        stackIds.push(stack.id);
      }

      await writeAudit(deps.db, {
        actor: METERING_ACTOR,
        organizationId: id,
        action: TRIAL_EXPIRED_ACTION,
        subject: id,
        detail: { stackIds, expiredAt: now.toISOString() },
      });
      await orgService.suspend({
        id,
        actor: METERING_ACTOR,
        reason: "billing",
      });
      results.push({ organizationId: id, stackIds });
    } catch (error) {
      await writeAudit(deps.db, {
        actor: METERING_ACTOR,
        organizationId: id,
        action: ENFORCEMENT_FAILED_ACTION,
        subject: id,
        detail: { step: "trial_expiry", reason: reasonOf(error) },
      }).catch(() => undefined);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// The nightly job
// ---------------------------------------------------------------------------

export interface BillingSweepResult {
  usage: UsageSweepResult;
  enforcement: EnforcementResult;
  dunning: EnforceDunningResult;
  /** PRD 09. Absent only if the whole leg failed — see `runBillingSweep`. */
  email?: {
    warnings: WarnAllowanceResult;
    overage: ReportOverageResult;
    reconciliation: ReconcileOverageResult;
  };
}

/**
 * The whole nightly job, in the only order that makes sense: meter first (so
 * enforcement judges tonight's numbers rather than last night's), enforce
 * second, and expire the dunning grace last — nothing in a provider's event
 * stream marks the moment a grace period ENDS, only the clock does.
 */
export async function runBillingSweep(
  overrides: Partial<MeteringDeps> = {},
): Promise<BillingSweepResult> {
  const deps = resolve(overrides);
  const usage = await sweepUsage(deps);
  const enforcement = await enforcePlanLimits(deps);
  const email = await runEmailUsageBilling(deps);
  const dunning = await new PlanService(deps.db, {
    substrate: deps.substrate,
  }).enforceDunningGrace({ now: deps.now() });
  return { usage, enforcement, dunning, ...(email ? { email } : {}) };
}

/**
 * The Hogsend Email leg: warn, bill, reconcile (PRD 09).
 *
 * WARN before BILL so a tenant crossing their allowance tonight hears about it
 * in the same run that charges for it, and RECONCILE last so it judges the
 * ledger this run just wrote.
 *
 * Wrapped whole. A billing provider outage must not cost the fleet its metering
 * or its dunning enforcement, and every step inside is itself re-runnable — so
 * the next night repairs what tonight dropped.
 */
async function runEmailUsageBilling(
  deps: MeteringDeps,
): Promise<BillingSweepResult["email"]> {
  const overrides = { db: deps.db, now: deps.now };
  try {
    return {
      warnings: await warnEmailAllowance(overrides),
      overage: await reportEmailOverage(overrides),
      reconciliation: await reconcileEmailOverage(overrides),
    };
  } catch (error) {
    console.error(
      "[cloud:metering] email usage billing failed:",
      reasonOf(error),
    );
    return undefined;
  }
}
