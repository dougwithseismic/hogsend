import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cells, organizations, stacks } from "../db/schema";
import { decryptSecretPayload } from "../lib/crypto";
import { writeAudit } from "../services/audit";
import { NotFoundError } from "../services/errors";
import type { StackRow } from "../services/orgs";
import { StackService } from "../services/stacks";
import { TenantDbService } from "../services/tenant-db";
import {
  getSubstrate,
  type StackRefs,
  SubstrateNotFoundError,
  type SubstrateProvider,
} from "../substrate";

/**
 * The other three lifecycle verbs: suspend, resume, destroy.
 *
 * They follow `pipeline/provision.ts` deliberately — same idempotency idiom
 * (a step proves it already ran from a PERSISTED artifact), same audit
 * discipline (one row per named step), same rule that `StackService` is the only
 * writer of `status`. The laws worth stating separately here:
 *
 *  - **Substrate first, status second.** Provisioning transitions INTO a working
 *    status (`provisioning`) because it has one; suspend and resume do not —
 *    there is no "suspending" state, and `error` is not reachable from
 *    `suspended`. So the infrastructure call happens BEFORE the transition: a
 *    substrate failure leaves the row exactly where it was, honestly describing
 *    a stack that never moved, and a retry re-drives an idempotent call.
 *  - **Destroy is the exception, and takes the working status it has.**
 *    `destroying` IS a state, and IS failable, so destroy transitions in first
 *    and parks in `error` on failure — from which `error → destroying` (the
 *    edge table's deliberate exception) lets a retry resume.
 *  - **Only `suspended` and `error` may be destroyed.** Not enforced by an `if`
 *    here but by `LEGAL_EDGES`: `legalSources("destroying")` is exactly those
 *    two, so a `running` stack is refused by the guarded UPDATE with an
 *    `IllegalTransitionError`, whatever this module believes.
 *  - **Nothing here logs a secret.** The tenant DSN, the Hatchet token and the
 *    stack secrets are CLEARED by destroy and never read on the way out.
 */

/** The actor recorded on every row these functions write. */
export const LIFECYCLE_ACTOR = "lifecycle";

/** Destroy, in order. Exported so tests + the dashboard can name a step. */
export const DESTROY_STEPS = [
  "start",
  "substrate-destroy",
  "drop-tenant-db",
  "clear-secrets",
  "finish",
] as const;

export type DestroyStep = (typeof DESTROY_STEPS)[number];

/** The audit `action` a destroy step writes. `stack.destroy.drop-tenant-db`, … */
export function destroyAuditAction(step: DestroyStep): string {
  return `stack.destroy.${step}`;
}

export interface LifecycleDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  tenantDb: TenantDbService;
  stackService: StackService;
}

function defaultDeps(): LifecycleDeps {
  return {
    db: defaultDb,
    // Resolved per run, like the provision pipeline: a misconfigured railway
    // substrate must fail THIS call, not module import.
    substrate: getSubstrate(),
    tenantDb: new TenantDbService(),
    stackService: new StackService(),
  };
}

export interface SuspendResult {
  stackId: string;
  status: "suspended";
  /** True when the stack was already suspended and nothing was called. */
  skipped: boolean;
}

export interface ResumeResult {
  stackId: string;
  status: "running";
  skipped: boolean;
}

export interface ResumeFailure {
  stackId: string;
  reason: string;
}

export interface ResumeOrganizationResult {
  organizationId: string;
  /** Stacks moved `suspended → running` by this call. */
  resumed: string[];
  failed: ResumeFailure[];
}

export interface DestroyStepReport {
  step: DestroyStep;
  /** True when a persisted artifact made the work unnecessary. */
  skipped: boolean;
}

export type DestroyResult =
  | { stackId: string; status: "destroyed"; steps: DestroyStepReport[] }
  | {
      stackId: string;
      status: "error";
      steps: DestroyStepReport[];
      failedStep: DestroyStep;
      error: string;
    };

/**
 * The pipeline's own bookkeeping, stored alongside the substrate's opaque
 * handle on `stacks.substrate_refs`.
 *
 * Destroy's steps have no natural artifact of their own — "the substrate stack
 * is gone" and "the tenant database is gone" are ABSENCES — so each one records
 * a flag here on success. That is what makes a resumed destroy skip the work it
 * already did rather than re-calling a vendor for a resource that no longer
 * exists (and re-reading a `SubstrateNotFoundError` every time).
 */
const SUBSTRATE_DESTROYED_KEY = "substrateDestroyed";
const TENANT_DB_DROPPED_KEY = "tenantDbDropped";

/**
 * Read the seam fields back out of the stored jsonb (which also carries the
 * pipeline's own keys). Returns null for a stack that never reached a
 * substrate — legal for an `error` stack, and the reason every substrate call
 * below is conditional.
 */
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

function flag(stack: StackRow, key: string): boolean {
  return (stack.substrateRefs as Record<string, unknown>)?.[key] === true;
}

async function loadStack(db: CloudDb, stackId: string): Promise<StackRow> {
  const [row] = await db
    .select()
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .limit(1);
  if (!row) throw new NotFoundError("Stack", stackId);
  return row;
}

/** Merge into `substrate_refs` and return the fresh row. Never touches status. */
async function markRefs(
  db: CloudDb,
  stack: StackRow,
  patch: Record<string, unknown>,
): Promise<StackRow> {
  const [row] = await db
    .update(stacks)
    .set({
      substrateRefs: { ...(stack.substrateRefs ?? {}), ...patch },
      updatedAt: new Date(),
    })
    .where(eq(stacks.id, stack.id))
    .returning();
  if (!row) throw new NotFoundError("Stack", stack.id);
  return row;
}

/**
 * Pause a stack: `running → suspended`.
 *
 * Idempotent by STATUS rather than by artifact — "already suspended" is the
 * whole answer, and re-suspending would call the substrate for no reason.
 */
export async function suspendStack(
  input: { stackId: string },
  overrides: Partial<LifecycleDeps> = {},
): Promise<SuspendResult> {
  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };
  const { stackId } = input;

  const stack = await loadStack(deps.db, stackId);
  if (stack.status === "suspended") {
    return { stackId, status: "suspended", skipped: true };
  }

  // Substrate BEFORE status: a failure here leaves the row honestly `running`
  // (see the module note), and `suspend` is idempotent on every implementation.
  const refs = readRefs(stack);
  if (refs) await deps.substrate.suspend(refs);

  await deps.stackService.transition({
    stackId,
    to: "suspended",
    expectedFrom: "running",
    actor: LIFECYCLE_ACTOR,
    detail: { verb: "suspend" },
  });
  await writeAudit(deps.db, {
    actor: LIFECYCLE_ACTOR,
    organizationId: stack.organizationId,
    action: "stack.suspend",
    subject: stackId,
    detail: { substrate: refs?.substrate ?? null },
  });

  return { stackId, status: "suspended", skipped: false };
}

/** Un-pause a stack: `suspended → running`. Idempotent by status. */
export async function resumeStack(
  input: { stackId: string },
  overrides: Partial<LifecycleDeps> = {},
): Promise<ResumeResult> {
  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };
  const { stackId } = input;

  const stack = await loadStack(deps.db, stackId);
  if (stack.status === "running") {
    return { stackId, status: "running", skipped: true };
  }

  const refs = readRefs(stack);
  if (refs) await deps.substrate.resume(refs);

  await deps.stackService.transition({
    stackId,
    to: "running",
    expectedFrom: "suspended",
    actor: LIFECYCLE_ACTOR,
    detail: { verb: "resume" },
  });
  await writeAudit(deps.db, {
    actor: LIFECYCLE_ACTOR,
    organizationId: stack.organizationId,
    action: "stack.resume",
    subject: stackId,
    detail: { substrate: refs?.substrate ?? null },
  });

  return { stackId, status: "running", skipped: false };
}

/**
 * Un-pause every suspended stack an organization owns.
 *
 * This is what makes a billing recovery real. `OrgService.unsuspend` writes one
 * boolean on the `organizations` row; the tenant's instance is stopped at the
 * SUBSTRATE, and nothing about clearing a flag starts a container. Without this,
 * a customer whose trial expired could complete a checkout, watch the dashboard
 * say "active", and still have a dead API.
 *
 * Per-stack wrapped: an org with four environments must not lose three of them
 * to one substrate error, and the failure is audited so an operator can finish
 * the job by hand.
 *
 * It resumes EVERY suspended stack, including one a dashboard click paused
 * before the billing stop landed — a per-stack "why" does not exist, and the
 * only caller is an org-wide billing recovery, where bringing the tenant back
 * whole is the answer that costs nothing to undo.
 */
export async function resumeOrganizationStacks(
  input: { organizationId: string },
  overrides: Partial<LifecycleDeps> = {},
): Promise<ResumeOrganizationResult> {
  const { organizationId } = input;
  const database = overrides.db ?? defaultDb;

  const suspended = await database
    .select({ id: stacks.id })
    .from(stacks)
    .where(
      and(
        eq(stacks.organizationId, organizationId),
        eq(stacks.status, "suspended"),
      ),
    );
  // Resolved only when there is work: constructing the substrate is a live
  // credential check, and a recovery for a tenant with nothing stopped must not
  // depend on one.
  if (suspended.length === 0)
    return { organizationId, resumed: [], failed: [] };

  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };
  const resumed: string[] = [];
  const failed: ResumeFailure[] = [];

  for (const { id } of suspended) {
    try {
      await resumeStack({ stackId: id }, deps);
      resumed.push(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({ stackId: id, reason });
      await writeAudit(deps.db, {
        actor: LIFECYCLE_ACTOR,
        organizationId,
        action: "stack.resume_failed",
        subject: id,
        detail: { reason },
      }).catch(() => undefined);
    }
  }

  return { organizationId, resumed, failed };
}

/**
 * Tear a stack down for good: `suspended | error → destroying → destroyed`.
 *
 * Returns rather than throws on a STEP failure (the stack is parked in `error`
 * by then, and a durable task wants a value) — but an illegal entry edge, such
 * as destroy-from-`running`, THROWS `IllegalTransitionError`. That distinction
 * is the point: a refused destroy is the caller's mistake and must be loud,
 * while a failed destroy is infrastructure and must be resumable.
 */
export async function destroyStack(
  input: { stackId: string },
  overrides: Partial<LifecycleDeps> = {},
): Promise<DestroyResult> {
  const deps: LifecycleDeps = { ...defaultDeps(), ...overrides };
  const { stackId } = input;
  const steps: DestroyStepReport[] = [];
  let current: DestroyStep = "start";

  let stack = await loadStack(deps.db, stackId);
  const organizationId = stack.organizationId;

  const audit = (step: DestroyStep, detail: Record<string, unknown>) =>
    writeAudit(deps.db, {
      actor: LIFECYCLE_ACTOR,
      organizationId,
      action: destroyAuditAction(step),
      subject: stackId,
      detail,
    });

  if (stack.status === "destroyed") {
    return { stackId, status: "destroyed", steps };
  }

  // ---- start --------------------------------------------------------------
  // OUTSIDE the try: an illegal entry edge is not a step failure to be parked,
  // it is a refusal to be raised. `legalSources("destroying")` is the guard —
  // suspended and error only, so `running` is rejected right here.
  const enteredFrom = stack.status;
  if (stack.status !== "destroying") {
    stack = await deps.stackService.transition({
      stackId,
      to: "destroying",
      actor: LIFECYCLE_ACTOR,
      detail: { verb: "destroy", from: enteredFrom },
    });
  }
  steps.push({ step: "start", skipped: enteredFrom === "destroying" });
  await audit("start", { from: enteredFrom });

  try {
    // ---- substrate-destroy -------------------------------------------------
    current = "substrate-destroy";
    const refs = readRefs(stack);
    if (!refs || flag(stack, SUBSTRATE_DESTROYED_KEY)) {
      steps.push({ step: "substrate-destroy", skipped: true });
      await audit("substrate-destroy", {
        reused: true,
        hadRefs: Boolean(refs),
      });
    } else {
      let alreadyGone = false;
      try {
        await deps.substrate.destroyStack(refs);
      } catch (error) {
        // Already gone is SUCCESS: destroy's goal is an absence, and waiting
        // does not make a deleted stack reappear.
        if (!(error instanceof SubstrateNotFoundError)) throw error;
        alreadyGone = true;
      }
      stack = await markRefs(deps.db, stack, {
        [SUBSTRATE_DESTROYED_KEY]: true,
      });
      steps.push({ step: "substrate-destroy", skipped: false });
      await audit("substrate-destroy", {
        substrate: refs.substrate,
        alreadyGone,
      });
    }

    // ---- drop-tenant-db ----------------------------------------------------
    current = "drop-tenant-db";
    const dbName = stack.dbName;
    if (!dbName || flag(stack, TENANT_DB_DROPPED_KEY)) {
      steps.push({ step: "drop-tenant-db", skipped: true });
      await audit("drop-tenant-db", { reused: true, dbName: dbName ?? null });
    } else {
      const cellDsn = await loadCellDsn(deps.db, organizationId);
      if (!cellDsn) {
        throw new Error(
          `Organization ${organizationId} has no cell; cannot drop tenant database "${dbName}"`,
        );
      }
      // `confirm` is the service's own destroy guard, and the value it demands
      // is the database name — supplied here from the ROW, so a destroy can
      // only ever drop the database this stack actually owns.
      const dropped = await deps.tenantDb.drop({
        cellDsn,
        dbName,
        confirm: dbName,
      });
      stack = await markRefs(deps.db, stack, { [TENANT_DB_DROPPED_KEY]: true });
      steps.push({ step: "drop-tenant-db", skipped: false });
      await audit("drop-tenant-db", { dbName, ...dropped });
    }

    // ---- clear-secrets -----------------------------------------------------
    // The stack is gone; its credentials are now pure liability. Nulled rather
    // than left encrypted so a future key compromise has nothing to open.
    current = "clear-secrets";
    const [cleared] = await deps.db
      .update(stacks)
      .set({
        dbDsnEncrypted: null,
        hatchetTokenEncrypted: null,
        stackSecretsEncrypted: null,
        updatedAt: new Date(),
      })
      .where(eq(stacks.id, stackId))
      .returning();
    if (!cleared) throw new NotFoundError("Stack", stackId);
    stack = cleared;
    steps.push({ step: "clear-secrets", skipped: false });
    await audit("clear-secrets", {
      cleared: [
        "db_dsn_encrypted",
        "hatchet_token_encrypted",
        "stack_secrets_encrypted",
      ],
    });

    // ---- finish ------------------------------------------------------------
    current = "finish";
    await deps.stackService.transition({
      stackId,
      to: "destroyed",
      expectedFrom: "destroying",
      actor: LIFECYCLE_ACTOR,
      detail: { step: "finish" },
    });
    steps.push({ step: "finish", skipped: false });
    await audit("finish", { status: "destroyed" });

    return { stackId, status: "destroyed", steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.stackService.recordError({
      stackId,
      error: `[${current}] ${message}`,
      step: current,
      actor: LIFECYCLE_ACTOR,
    });
    return {
      stackId,
      status: "error",
      steps,
      failedStep: current,
      error: message,
    };
  }
}

/** The org's cell admin DSN, decrypted. Null for a dedicated (cell-less) org. */
async function loadCellDsn(
  db: CloudDb,
  organizationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ dsn: cells.sharedClusterDsn })
    .from(organizations)
    .leftJoin(cells, eq(cells.id, organizations.cellId))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.dsn ? decryptSecretPayload<string>(row.dsn) : null;
}
