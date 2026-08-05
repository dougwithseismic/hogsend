import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
import { enqueueProvision as defaultEnqueueProvision } from "../pipeline/enqueue";
import type {
  DestroyResult,
  LifecycleDeps,
  ResumeResult,
  SuspendResult,
} from "../pipeline/lifecycle";
import {
  destroyStack as defaultDestroyStack,
  resumeStack as defaultResumeStack,
  suspendStack as defaultSuspendStack,
} from "../pipeline/lifecycle";
import {
  rollbackToBuild as defaultRollbackToBuild,
  type RollbackResult,
} from "../pipeline/rollback";
import type { CreateEnvironmentResult } from "../services/environments";
import { IllegalTransitionError, NotFoundError } from "../services/errors";
import { legalSources, type StackStatus } from "../services/stacks";
import {
  provisionEnvironment as defaultProvisionEnvironment,
  type ProvisionEnvironmentDeps,
} from "./environment-provision";
import type { OrgMembersDeps } from "./org-members";
import { NotPermittedError, readMemberContext, roleList } from "./org-members";

/**
 * The three destructive environment operations, and the rules that gate them.
 *
 * This module is the twin of `lib/org-members.ts` and exists for the same
 * reason: the server actions above it are form parsers, and the AUTHORIZATION
 * has to live somewhere a test can reach with a real session and no Next
 * request. A hidden button is not a permission check — `/environments` server
 * actions are POST endpoints anyone with a session can call.
 *
 * Three rules, in this order, every time:
 *  1. **The caller is an owner or admin.** A member may look at an environment;
 *     only an operator may stop, start or delete one.
 *  2. **The environment belongs to the CALLER's organization.** Scoped in the
 *     query, so a cross-tenant id reads as "not found" rather than leaking that
 *     it exists somewhere else.
 *  3. **Destroy also matches the environment NAME.** The same posture as
 *     `TenantDbService.drop`'s `confirm`: an irreversible call must name what it
 *     is about to remove. Checked HERE (not only in the form) because the form
 *     is not the boundary.
 *
 * The state machine itself is NOT re-implemented here. Which statuses may
 * suspend or destroy is `LEGAL_EDGES`' answer, raised as `IllegalTransitionError`
 * from `StackService`; duplicating it in an `if` would let the two drift.
 */

/** Roles allowed to suspend, resume and destroy an environment. */
const OPERATOR_ROLES = new Set<string>(["owner", "admin"]);

export function canOperateEnvironments(
  role: string | null | undefined,
): boolean {
  return roleList(role).some((value) => OPERATOR_ROLES.has(value));
}

export function assertCanOperateEnvironments(
  role: string | null | undefined,
): void {
  if (!canOperateEnvironments(role)) {
    throw new NotPermittedError(
      "Only an owner or admin can suspend, resume or destroy an environment.",
    );
  }
}

/** The four controls the environment page can render. */
export type EnvironmentOperation = "retry" | "suspend" | "resume" | "destroy";

/**
 * Which operations each status admits — the dashboard's half of the no-dead-
 * buttons rule.
 *
 * Derived from `LEGAL_EDGES`, never re-deriving it: every entry below is an
 * edge the state machine already allows, asserted at module load by
 * {@link assertOperationsAreLegalEdges} so a change to the transition table
 * that orphans a button fails the test suite rather than the browser.
 *
 * It is deliberately NARROWER than the table in one place: `error → suspended`
 * is a legal edge, but a stack that never came up has nothing to pause, and
 * `error` already offers the two operations that move it (retry, destroy).
 */
const OPERATION_EDGE: Record<EnvironmentOperation, StackStatus> = {
  retry: "provisioning",
  suspend: "suspended",
  resume: "running",
  destroy: "destroying",
};

export const OPERATIONS_BY_STATUS = {
  // A `deferred` stack has asked for nothing yet: there is no failed step to
  // retry and no substrate to pause or tear down. The publish is what starts
  // it, so the environment page offers no button that would pretend otherwise.
  deferred: [],
  requested: ["retry"],
  provisioning: [],
  running: ["suspend"],
  publishing: [],
  suspended: ["resume", "destroy"],
  destroying: [],
  destroyed: [],
  error: ["retry", "destroy"],
} as const satisfies Record<StackStatus, readonly EnvironmentOperation[]>;

function assertOperationsAreLegalEdges(): void {
  for (const [status, operations] of Object.entries(OPERATIONS_BY_STATUS)) {
    for (const operation of operations as readonly EnvironmentOperation[]) {
      const to = OPERATION_EDGE[operation];
      if (!legalSources(to).includes(status as StackStatus)) {
        throw new Error(
          `Environment operation "${operation}" is offered from "${status}", which cannot reach "${to}"`,
        );
      }
    }
  }
}
assertOperationsAreLegalEdges();

/**
 * The operations this caller may run on this stack RIGHT NOW: their role and
 * the stack's status, both, with no third input.
 *
 * Pure, so the page renders exactly the set the server would accept — the two
 * cannot drift into a button that always refuses, or a legal operation with no
 * control. It is a courtesy, not the enforcement: every operation below
 * re-checks the role, and the state machine re-checks the edge.
 */
export function allowedOperations(input: {
  role: string | null | undefined;
  /** null when the environment has no stack row at all. */
  status: StackStatus | null;
}): EnvironmentOperation[] {
  if (!canOperateEnvironments(input.role)) return [];
  if (!input.status) return [];
  return [...OPERATIONS_BY_STATUS[input.status]];
}

/** A destroy arrived without the environment name that confirms it. */
export class ConfirmationMismatchError extends Error {
  readonly code = "confirmation_mismatch";

  constructor(readonly environmentName: string) {
    super(
      `Type the environment name "${environmentName}" to confirm this destroy.`,
    );
    this.name = "ConfirmationMismatchError";
  }
}

export interface EnvironmentOpsDeps extends OrgMembersDeps {
  db?: CloudDb;
  /** Pipeline dependency overrides (the substrate, mostly) for tests + dev. */
  lifecycle?: Partial<LifecycleDeps>;
  suspendStack?: typeof defaultSuspendStack;
  resumeStack?: typeof defaultResumeStack;
  destroyStack?: typeof defaultDestroyStack;
  rollbackToBuild?: typeof defaultRollbackToBuild;
  enqueueProvision?: typeof defaultEnqueueProvision;
  /** Creation goes through `provisionEnvironment`, never the service alone. */
  provisionEnvironment?: typeof defaultProvisionEnvironment;
  provision?: ProvisionEnvironmentDeps;
}

interface ResolvedEnvironment {
  organizationId: string;
  /** The CALLER, for audit attribution — never the organization id. */
  userId: string;
  environmentId: string;
  environmentName: string;
  stackId: string;
  stackStatus: StackStatus;
}

/**
 * The caller's role + the environment's stack, resolved together. Every
 * operation below starts here, so no path can skip a rule by accident.
 */
async function resolveOperation(
  headers: Headers,
  input: { environmentId: string },
  deps: EnvironmentOpsDeps,
): Promise<ResolvedEnvironment> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);
  assertCanOperateEnvironments(context.role);

  const [row] = await db
    .select({
      environmentId: environments.id,
      environmentName: environments.name,
      stackId: stacks.id,
      stackStatus: stacks.status,
    })
    .from(environments)
    .innerJoin(stacks, eq(stacks.environmentId, environments.id))
    .where(
      and(
        eq(environments.id, input.environmentId),
        eq(environments.organizationId, context.organizationId),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundError("Environment", input.environmentId);

  return {
    organizationId: context.organizationId,
    userId: context.userId,
    ...row,
  };
}

export async function suspendEnvironment(
  headers: Headers,
  input: { environmentId: string },
  deps: EnvironmentOpsDeps = {},
): Promise<SuspendResult> {
  const resolved = await resolveOperation(headers, input, deps);
  const suspend = deps.suspendStack ?? defaultSuspendStack;
  return suspend({ stackId: resolved.stackId }, deps.lifecycle ?? {});
}

export async function resumeEnvironment(
  headers: Headers,
  input: { environmentId: string },
  deps: EnvironmentOpsDeps = {},
): Promise<ResumeResult> {
  const resolved = await resolveOperation(headers, input, deps);
  const resume = deps.resumeStack ?? defaultResumeStack;
  return resume({ stackId: resolved.stackId }, deps.lifecycle ?? {});
}

/**
 * Put a previous build back on this environment's stack.
 *
 * Behind the SAME gate as suspend and destroy — `resolveOperation` checks the
 * caller's role and scopes the environment to their organization — because
 * this replaces the running code. A member may read builds; only an owner or
 * admin may make one live again.
 *
 * The pipeline re-checks that the build belongs to this environment, so a build
 * id borrowed from another tenant is refused twice over.
 */
export async function rollbackEnvironment(
  headers: Headers,
  input: { environmentId: string; buildId: string },
  deps: EnvironmentOpsDeps = {},
): Promise<RollbackResult> {
  const resolved = await resolveOperation(headers, input, deps);
  const rollback = deps.rollbackToBuild ?? defaultRollbackToBuild;
  return rollback({
    environmentId: resolved.environmentId,
    buildId: input.buildId,
    // The person who clicked it. An organization cannot roll anything back.
    actor: resolved.userId,
  });
}

export async function destroyEnvironment(
  headers: Headers,
  input: { environmentId: string; confirm: string },
  deps: EnvironmentOpsDeps = {},
): Promise<DestroyResult> {
  const resolved = await resolveOperation(headers, input, deps);
  // The confirmation is checked AFTER the role and the tenancy scope: a member
  // typing the right name still gets refused for the right reason, and a
  // stranger learns nothing about whether the name they guessed was correct.
  if (input.confirm !== resolved.environmentName) {
    throw new ConfirmationMismatchError(resolved.environmentName);
  }
  const destroy = deps.destroyStack ?? defaultDestroyStack;
  return destroy({ stackId: resolved.stackId }, deps.lifecycle ?? {});
}

/**
 * Retry provisioning — the dashboard's answer to a stack parked in `error`,
 * and to one whose enqueue was lost (`provisionEnvironment` logs a queue
 * failure rather than rolling back a legitimately created environment, so a
 * stack CAN sit in `requested` with nothing coming for it).
 *
 * `enqueueProvision` is the same call signup makes, and the pipeline resumes
 * from the failed step by finding the persisted artifacts of the steps that
 * already ran — this is not a re-provision from scratch.
 *
 * The status check is not the enforcement (the pipeline's first transition is),
 * it is what turns "your click did nothing" into a sentence: a stack that moved
 * on since the page rendered is named, with where it actually is.
 */
export async function retryEnvironmentProvisioning(
  headers: Headers,
  input: { environmentId: string },
  deps: EnvironmentOpsDeps = {},
): Promise<{ stackId: string }> {
  const resolved = await resolveOperation(headers, input, deps);
  if (!legalSources("provisioning").includes(resolved.stackStatus)) {
    throw new IllegalTransitionError(
      resolved.stackId,
      resolved.stackStatus,
      "provisioning",
    );
  }

  const enqueue = deps.enqueueProvision ?? defaultEnqueueProvision;
  await enqueue(resolved.stackId);
  return { stackId: resolved.stackId };
}

/**
 * Create an environment for the CALLER's organization, and start provisioning
 * it.
 *
 * Goes through `provisionEnvironment` rather than `EnvironmentService.create`
 * so the enqueue that makes an environment real cannot be forgotten by a
 * caller. The plan allowance and the single-production rule stay where they are
 * enforced — inside the service's transaction — and reach the form as a typed
 * `PlanLimitError` / `DuplicateNameError`.
 */
export async function createEnvironment(
  headers: Headers,
  input: { name: string; kind: "staging" | "test" },
  deps: EnvironmentOpsDeps = {},
): Promise<CreateEnvironmentResult> {
  const context = await readMemberContext(headers, deps);
  if (!canOperateEnvironments(context.role)) {
    throw new NotPermittedError(
      "Only an owner or admin can create an environment.",
    );
  }

  const provision = deps.provisionEnvironment ?? defaultProvisionEnvironment;
  return provision(
    {
      organizationId: context.organizationId,
      name: input.name,
      kind: input.kind,
      actor: context.userId,
    },
    deps.provision ?? {},
  );
}
