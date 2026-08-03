import { and, eq, inArray, sum } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { organizations, stacks, usageCounters } from "../db/schema";
import { writeAudit } from "../services/audit";
import type { OrganizationRow, StackRow } from "../services/orgs";
import { planLimits } from "../services/plan-limits";
import { billingWindow } from "../services/usage";
import {
  getSubstrate,
  type StackRefs,
  type SubstrateProvider,
} from "../substrate";

/**
 * Plan enforcement for ONE organization: compare the meter against the plan and
 * make the ingest flag agree with the answer.
 *
 * Its own module, and not a private half of `metering/sweep.ts`, because it has
 * two callers that must behave identically:
 *
 *  - the nightly sweep, which walks the fleet;
 *  - `PlanService`, on a plan change — a customer who upgrades at 04:00 UTC must
 *    not keep getting 429s until the next 03:00 cron, ~23 hours after paying.
 *
 * The laws:
 *
 *  - **The cap counts EVERY environment.** Metering production only would be a
 *    plan-enforcement bypass one SDK base-URL change wide: point at the staging
 *    stack and ingest forever. DECISIONS §2 sells the extra environments as
 *    part of the tier, not as extra allowance.
 *  - **The flag lands on every RUNNING stack in the org**, for the same reason.
 *  - **Idempotent on a PERSISTED marker.** `stacks.ingest_suspended_at` records
 *    the flag state, so a cap that stays breached all month costs exactly one
 *    `setEnv` + `redeploy`, not thirty. The marker is written only AFTER the
 *    substrate call succeeds — a marker ahead of a failed call would claim a
 *    suspension that never landed and no later sweep would retry it.
 *  - **One dead stack never stops the org.** Each stack is wrapped: the failure
 *    is audited and returned, and the next stack is still enforced.
 */

/** The engine env var that makes `/v1/events` answer 429 (DECISIONS §2). */
export const INGEST_SUSPENDED_ENV = "HOGSEND_INGEST_SUSPENDED";

/** The actor recorded on every row this module and the sweep write. */
export const METERING_ACTOR = "metering";

export const INGEST_SUSPENDED_ACTION = "usage.ingest_suspended";
export const INGEST_RESUMED_ACTION = "usage.ingest_resumed";
export const ENFORCEMENT_FAILED_ACTION = "usage.enforcement_failed";

/** An operator hint on a row read in a list; keep it short. */
const MAX_REASON_LENGTH = 500;

export function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_REASON_LENGTH);
}

export interface EnforcementDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  now: () => Date;
}

export function resolveEnforcementDeps(
  overrides: Partial<EnforcementDeps> = {},
): EnforcementDeps {
  return {
    db: defaultDb,
    // Resolved per run, like every other pipeline: a misconfigured railway
    // substrate must fail THIS call, not the import of any module near it.
    substrate: getSubstrate(),
    now: () => new Date(),
    ...overrides,
  };
}

export interface UsageTotals {
  events: number;
  emails: number;
}

export type EnforcementVerdict = "ingest_suspended" | "ingest_resumed";

export interface EnforcementAction {
  organizationId: string;
  stackId: string;
  environmentId: string;
  verdict: EnforcementVerdict;
  /** Billing-window totals, as they were when the verdict was made. */
  events: number;
  emails: number;
}

export interface StackFailure {
  stackId: string;
  organizationId: string;
  reason: string;
}

export interface ReconcileResult {
  organizationId: string;
  /** False when the org is missing or suspended — nothing was judged. */
  evaluated: boolean;
  over: boolean;
  totals: UsageTotals;
  actions: EnforcementAction[];
  failed: StackFailure[];
}

const NO_USAGE: UsageTotals = { events: 0, emails: 0 };

/** Read the seam fields out of the stored jsonb; null when never provisioned. */
function readRefs(stack: StackRow): StackRefs | null {
  const raw = stack.substrateRefs as Record<string, unknown>;
  if (!raw || typeof raw.substrate !== "string") return null;
  if (typeof raw.apiPublicUrl !== "string") return null;
  return {
    substrate: raw.substrate,
    apiPublicUrl: raw.apiPublicUrl,
    data: (raw.data as Record<string, unknown>) ?? {},
  };
}

/**
 * Everything the org used in its billing window, across every environment.
 */
export async function organizationTotals(
  db: CloudDb,
  organization: Pick<OrganizationRow, "id" | "plan" | "createdAt">,
  now: Date,
): Promise<UsageTotals> {
  const { months } = billingWindow(organization, now);
  const [row] = await db
    .select({
      events: sum(usageCounters.eventsCount),
      emails: sum(usageCounters.emailsCount),
    })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, organization.id),
        inArray(usageCounters.month, months),
      ),
    );
  return { events: Number(row?.events ?? 0), emails: Number(row?.emails ?? 0) };
}

/**
 * Make one organization's ingest flag agree with its meter.
 *
 * Safe to call from anywhere and as often as you like: the persisted marker
 * makes a no-change run write nothing at all.
 */
export async function reconcileIngestFlag(
  input: { organizationId: string },
  overrides: Partial<EnforcementDeps> = {},
): Promise<ReconcileResult> {
  const deps = resolveEnforcementDeps(overrides);
  const [organization] = await deps.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!organization) {
    return {
      organizationId: input.organizationId,
      evaluated: false,
      over: false,
      totals: NO_USAGE,
      actions: [],
      failed: [],
    };
  }
  return reconcileOrganization(deps, organization);
}

/**
 * The same enforcement against an already-read organization row — what the
 * fleet sweep calls, so walking the fleet is not one extra SELECT per tenant.
 */
export async function reconcileOrganization(
  deps: EnforcementDeps,
  organization: OrganizationRow,
): Promise<ReconcileResult> {
  // A suspended tenant's stacks are stopped: there is no ingest to pause, and a
  // `setEnv` against a stopped stack buys nothing. The suspension is the
  // stronger statement, and lifting it is billing's job, not the meter's.
  if (organization.suspendedAt) {
    return {
      organizationId: organization.id,
      evaluated: false,
      over: false,
      totals: NO_USAGE,
      actions: [],
      failed: [],
    };
  }

  const now = deps.now();
  const limits = planLimits(organization.plan);
  const totals = await organizationTotals(deps.db, organization, now);
  const over =
    totals.events > limits.eventsPerMonth ||
    totals.emails > limits.emailsPerMonth;

  const running = await deps.db
    .select()
    .from(stacks)
    .where(
      and(
        eq(stacks.organizationId, organization.id),
        eq(stacks.status, "running"),
      ),
    );

  const actions: EnforcementAction[] = [];
  const failed: StackFailure[] = [];

  for (const stack of running) {
    try {
      const action = await applyIngestFlag(deps, stack, over, totals, now);
      if (action) actions.push(action);
    } catch (error) {
      const reason = reasonOf(error);
      failed.push({
        stackId: stack.id,
        organizationId: organization.id,
        reason,
      });
      await writeAudit(deps.db, {
        actor: METERING_ACTOR,
        organizationId: organization.id,
        action: ENFORCEMENT_FAILED_ACTION,
        subject: stack.id,
        detail: { over, reason },
      }).catch(() => undefined);
    }
  }

  return {
    organizationId: organization.id,
    evaluated: true,
    over,
    totals,
    actions,
    failed,
  };
}

/**
 * Make one stack's ingest flag agree with `over`. Returns the action taken, or
 * null when the flag already said the right thing.
 */
async function applyIngestFlag(
  deps: EnforcementDeps,
  stack: StackRow,
  over: boolean,
  totals: UsageTotals,
  now: Date,
): Promise<EnforcementAction | null> {
  const suspended = stack.ingestSuspendedAt !== null;
  if (over === suspended) return null;

  const refs = readRefs(stack);
  if (!refs) {
    // A running stack with no substrate handle cannot be flagged. Loud rather
    // than silent: the row is claiming an instance nobody can reach.
    throw new Error("stack has no substrate refs");
  }

  // Substrate FIRST, marker second (see the module note). `null` UNSETS the
  // variable rather than writing "false", so the engine falls back to its own
  // default and the stack's env carries no stale enforcement state.
  await deps.substrate.setEnv(refs, {
    [INGEST_SUSPENDED_ENV]: over ? "true" : null,
  });
  // Env is read at boot; without a restart the instance keeps ingesting (or
  // keeps refusing) on the value it started with.
  await deps.substrate.redeploy(refs);

  await deps.db
    .update(stacks)
    .set({ ingestSuspendedAt: over ? now : null, updatedAt: now })
    .where(eq(stacks.id, stack.id));

  const verdict: EnforcementVerdict = over
    ? "ingest_suspended"
    : "ingest_resumed";
  await writeAudit(deps.db, {
    actor: METERING_ACTOR,
    organizationId: stack.organizationId,
    action: over ? INGEST_SUSPENDED_ACTION : INGEST_RESUMED_ACTION,
    subject: stack.id,
    detail: {
      events: totals.events,
      emails: totals.emails,
      envVar: INGEST_SUSPENDED_ENV,
    },
  });

  return {
    organizationId: stack.organizationId,
    stackId: stack.id,
    environmentId: stack.environmentId,
    verdict,
    events: totals.events,
    emails: totals.emails,
  };
}
