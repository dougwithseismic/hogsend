import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
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
import { NotFoundError } from "../services/errors";
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
}

interface ResolvedEnvironment {
  organizationId: string;
  environmentId: string;
  environmentName: string;
  stackId: string;
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

  return { organizationId: context.organizationId, ...row };
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
