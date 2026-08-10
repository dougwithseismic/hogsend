import { and, desc, eq, like, or } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  cloudAuditLog,
  environments,
  organizations,
  stackHealth,
  stacks,
} from "../db/schema";
import {
  getStackAlerts as defaultGetStackAlerts,
  type StackAlert,
} from "../pipeline/health-poll";
import {
  PROVISION_STEPS,
  type ProvisionStep,
  provisionAuditAction,
} from "../pipeline/provision";
import type { EnvironmentRow, StackRow } from "../services/orgs";
import {
  allowedOperations,
  type EnvironmentOperation,
} from "./environment-ops";
import type { OrgMembersDeps } from "./org-members";
import { readMemberContext } from "./org-members";

/**
 * Everything the environment detail page reads, and the pure derivations it
 * renders.
 *
 * The page itself is a server component and cannot be called from a test with
 * a session, so the tenancy guard lives HERE: `readEnvironmentDetail` resolves
 * the caller's organization from their membership and scopes the environment
 * query to it, returning null for anything else. A cross-tenant id is therefore
 * indistinguishable from a made-up one — the page turns both into a 404 — and
 * the guard is provable without a Next request.
 *
 * Nothing in this module writes. Provisioning progress is DERIVED from the
 * audit trail the pipeline already writes (`stack.provision.<step>`), not from
 * a second progress table that could disagree with it.
 */

export interface OperationsView {
  /** The caller's role in the organization, verbatim. */
  role: string;
  allowed: EnvironmentOperation[];
}

export type ProvisionStepState = "done" | "skipped" | "failed" | "pending";

export interface ProvisionStepView {
  step: ProvisionStep;
  state: ProvisionStepState;
  /** When the step last recorded itself; null while pending. */
  at: Date | null;
}

/** The audit columns the derivation needs — a row shape, not a table. */
export interface ProvisionAuditRow {
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

/** The audit `action` written when a step fails (`StackService.recordError`). */
const STACK_ERROR_ACTION = "stack.error";

/**
 * The step list, as the audit trail describes it.
 *
 * Three readings, in this order:
 *  - a step whose newest audit row says `reused: true` is **skipped** — the
 *    pipeline found a persisted artifact and did no work. Saying "done" would
 *    claim an action that never happened;
 *  - the step named by the newest `stack.error` row is **failed**, but only
 *    while the stack is actually in `error`. A retry that got past it must not
 *    keep a red mark on a step that has since succeeded;
 *  - a step with any other row is **done**; a step with none is **pending**.
 *
 * Pure and export-tested: it is the one place that decides what a provisioning
 * run looks like to a customer.
 */
export function deriveProvisionSteps(input: {
  audit: ProvisionAuditRow[];
  status: StackRow["status"];
}): ProvisionStepView[] {
  const newest = new Map<string, ProvisionAuditRow>();
  let failedStep: string | null = null;

  // Oldest-first so the last write for a step wins, which is what a retry's
  // second pass over the same step means.
  const ordered = [...input.audit].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const row of ordered) {
    if (row.action === STACK_ERROR_ACTION) {
      const step = row.detail?.step;
      failedStep = typeof step === "string" ? step : null;
      continue;
    }
    newest.set(row.action, row);
  }

  return PROVISION_STEPS.map((step) => {
    const row = newest.get(provisionAuditAction(step));
    if (input.status === "error" && failedStep === step) {
      return { step, state: "failed" as const, at: row?.createdAt ?? null };
    }
    if (!row) return { step, state: "pending" as const, at: null };
    return {
      step,
      state: row.detail?.reused === true ? "skipped" : "done",
      at: row.createdAt,
    };
  });
}

/**
 * What each pipeline step is DOING, in the customer's terms.
 *
 * The slug stays the identifier — it is what `last_error` names when a step
 * fails, so the page keeps showing it beside the sentence rather than instead
 * of it. This map only adds the reading a customer can act on; nobody outside
 * this codebase knows what `mint-hatchet` means.
 */
export const PROVISION_STEP_LABELS: Record<ProvisionStep, string> = {
  start: "Starting",
  "ensure-tenant-db": "Creating your database",
  "mint-hatchet": "Setting up background jobs",
  "substrate-provision": "Creating your services",
  "ensure-hostname": "Giving it a web address",
  "provision-ses": "Setting up email sending",
  "set-env": "Applying your settings",
  "start-services": "Starting your services",
  "health-wait": "Waiting for the first healthy check",
  "mint-credentials": "Creating your login",
  finish: "Finishing up",
};

export interface EnvironmentDetail {
  environment: EnvironmentRow;
  /** null when the environment has no stack row at all. */
  stack: StackRow | null;
  /** Shared cell or a cluster of this tenant's own — derived from the plan. */
  topology: "shared" | "dedicated";
  plan: string;
  steps: ProvisionStepView[];
  /** Recent health observations, newest first. */
  health: HealthObservationRow[];
  /** Set when this stack has failed the alert streak of consecutive sweeps. */
  alert: StackAlert | null;
  operations: OperationsView;
}

export interface HealthObservationRow {
  id: string;
  healthy: boolean;
  detail: string | null;
  checkedAt: Date;
}

/** How many sweeps the detail page's health strip shows. */
export const HEALTH_STRIP_LENGTH = 24;

export interface EnvironmentDetailDeps extends OrgMembersDeps {
  db?: CloudDb;
  getStackAlerts?: typeof defaultGetStackAlerts;
}

/**
 * One environment, scoped to the caller's organization. Null when there is no
 * such environment THERE — whether it does not exist or belongs to someone
 * else, which the caller is not told apart.
 */
export async function readEnvironmentDetail(
  headers: Headers,
  input: { environmentId: string },
  deps: EnvironmentDetailDeps = {},
): Promise<EnvironmentDetail | null> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);

  const [row] = await db
    .select({
      environment: environments,
      stack: stacks,
      plan: organizations.plan,
    })
    .from(environments)
    .innerJoin(organizations, eq(organizations.id, environments.organizationId))
    .leftJoin(stacks, eq(stacks.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, input.environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const stack = row.stack;
  const [audit, health, alerts] = await Promise.all([
    stack ? readProvisionAudit(db, stack.id) : Promise.resolve([]),
    stack ? readHealth(db, stack.id) : Promise.resolve([]),
    stack?.status === "running"
      ? (deps.getStackAlerts ?? defaultGetStackAlerts)(
          { organizationId: context.organizationId },
          { db },
        )
      : Promise.resolve([] as StackAlert[]),
  ]);

  return {
    environment: row.environment,
    stack,
    // Not a stored column: the pipeline decides it from the plan at
    // `substrate.provisionStack` time, so the page reads it the same way.
    topology: row.plan === "dedicated" ? "dedicated" : "shared",
    plan: row.plan,
    steps: stack
      ? deriveProvisionSteps({ audit, status: stack.status })
      : PROVISION_STEPS.map((step) => ({
          step,
          state: "pending" as const,
          at: null,
        })),
    health,
    alert: alerts.find((entry) => entry.stackId === stack?.id) ?? null,
    operations: {
      role: context.role,
      allowed: allowedOperations({
        role: context.role,
        status: stack?.status ?? null,
      }),
    },
  };
}

/** The provisioning trail for one stack: every step row, plus its failures. */
async function readProvisionAudit(
  db: CloudDb,
  stackId: string,
): Promise<ProvisionAuditRow[]> {
  const rows = await db
    .select({
      action: cloudAuditLog.action,
      detail: cloudAuditLog.detail,
      createdAt: cloudAuditLog.createdAt,
    })
    .from(cloudAuditLog)
    .where(
      and(
        eq(cloudAuditLog.subject, stackId),
        or(
          like(cloudAuditLog.action, "stack.provision.%"),
          eq(cloudAuditLog.action, STACK_ERROR_ACTION),
        ),
      ),
    )
    .orderBy(cloudAuditLog.createdAt);
  return rows.map((entry) => ({ ...entry, detail: entry.detail ?? null }));
}

async function readHealth(
  db: CloudDb,
  stackId: string,
): Promise<HealthObservationRow[]> {
  return db
    .select({
      id: stackHealth.id,
      healthy: stackHealth.healthy,
      detail: stackHealth.detail,
      checkedAt: stackHealth.checkedAt,
    })
    .from(stackHealth)
    .where(eq(stackHealth.stackId, stackId))
    .orderBy(desc(stackHealth.checkedAt), desc(stackHealth.id))
    .limit(HEALTH_STRIP_LENGTH);
}
