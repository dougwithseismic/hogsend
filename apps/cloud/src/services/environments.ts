import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, organizations, stacks } from "../db/schema";
import { removeEnvironmentArtifacts } from "../lib/artifacts";
import { writeAudit } from "./audit";
import {
  DuplicateNameError,
  DuplicateProductionError,
  isUniqueViolation,
  NotFoundError,
  PlanLimitError,
  ProductionRemovalError,
  StackNotRemovableError,
} from "./errors";
import {
  type EnvironmentRow,
  insertEnvironmentWithStack,
  PLAN_ENVIRONMENT_LIMITS,
  type StackRow,
} from "./orgs";

/**
 * Environments inside an organization, and the plan rules that bound them.
 *
 * The invariants this service exists to hold:
 *  - the plan allowance (DECISIONS §2: trial 1 / self-serve 2 / dedicated 4) is
 *    counted INSIDE the transaction that inserts, so two concurrent creates
 *    cannot both pass a stale count;
 *  - exactly one `production` per org — a service rule rather than a partial
 *    index, deliberately (see `enums.ts`);
 *  - `(organization_id, name)` uniqueness stays the DATABASE's job; we only
 *    translate its 23505 into a rule the caller can read;
 *  - removing an environment is legal ONLY before infrastructure exists (stack
 *    `requested`) or after it is gone (`destroyed`). Anything in between would
 *    orphan live substrate, so the caller runs suspend → destroy (PRD 04) first.
 */

/** The only stack statuses at which no substrate can be orphaned. */
const REMOVABLE_STACK_STATUSES = new Set(["requested", "destroyed"]);

const nameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "Environment name must be lowercase alphanumeric with dashes",
  );

const actorSchema = z.string().min(1).max(200);

const createInputSchema = z.object({
  organizationId: z.string().min(1).max(200),
  name: nameSchema,
  kind: z.enum(["production", "staging", "test"]),
  actor: actorSchema.optional(),
});

const listInputSchema = z.object({
  organizationId: z.string().min(1).max(200),
});

const removeInputSchema = z.object({
  organizationId: z.string().min(1).max(200),
  environmentId: z.uuid(),
  actor: actorSchema.optional(),
});

export type CreateEnvironmentInput = z.input<typeof createInputSchema>;
export type RemoveEnvironmentInput = z.input<typeof removeInputSchema>;

export interface CreateEnvironmentResult {
  environment: EnvironmentRow;
  stack: StackRow;
}

/** One environment with the status of its stack — the dashboard's list row. */
export interface EnvironmentWithStack extends EnvironmentRow {
  stack: {
    id: string;
    status: StackRow["status"];
    region: StackRow["region"];
    lastError: string | null;
    engineVersion: string | null;
  } | null;
}

export type ListEnvironmentsResult = { environments: EnvironmentWithStack[] };
export type RemoveEnvironmentResult = { removed: true };

export class EnvironmentService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Create an environment and its `requested` stack, atomically, after the two
   * rules that can refuse it: the plan allowance and single-production.
   */
  async create(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult> {
    const { organizationId, name, kind, actor } =
      createInputSchema.parse(input);

    try {
      return await this.db.transaction(async (tx) => {
        const [organization] = await tx
          .select({
            plan: organizations.plan,
            region: organizations.region,
          })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1)
          // Serialises concurrent creates for one tenant, so the allowance
          // count below cannot be read stale by two transactions at once.
          .for("update");
        if (!organization) {
          throw new NotFoundError("Organization", organizationId);
        }

        const limit = PLAN_ENVIRONMENT_LIMITS[organization.plan];
        const [existing] = await tx
          .select({ total: count() })
          .from(environments)
          .where(eq(environments.organizationId, organizationId));
        const current = existing?.total ?? 0;
        if (current >= limit) {
          throw new PlanLimitError(organization.plan, limit, current);
        }

        if (kind === "production") {
          const [production] = await tx
            .select({ id: environments.id })
            .from(environments)
            .where(
              and(
                eq(environments.organizationId, organizationId),
                eq(environments.kind, "production"),
              ),
            )
            .limit(1);
          if (production) throw new DuplicateProductionError(organizationId);
        }

        const created = await insertEnvironmentWithStack(tx, {
          organizationId,
          name,
          kind,
          region: organization.region,
        });

        await writeAudit(tx, {
          actor,
          organizationId,
          action: "environment.created",
          subject: created.environment.id,
          detail: { name, kind, stackId: created.stack.id },
        });

        return created;
      });
    } catch (error) {
      // The name rule is the DATABASE's — we only give it a typed voice.
      if (isUniqueViolation(error)) {
        throw new DuplicateNameError(organizationId, name);
      }
      throw error;
    }
  }

  /** Every environment for one tenant, each with its stack status. */
  async list(input: {
    organizationId: string;
  }): Promise<ListEnvironmentsResult> {
    const { organizationId } = listInputSchema.parse(input);

    const rows = await this.db
      .select({
        environment: environments,
        stackId: stacks.id,
        stackStatus: stacks.status,
        stackRegion: stacks.region,
        stackLastError: stacks.lastError,
        stackEngineVersion: stacks.engineVersion,
      })
      .from(environments)
      // LEFT: the 1:1 stack is created with the environment today, but a read
      // must never vanish a tenant's environment if that ever stops holding.
      .leftJoin(stacks, eq(stacks.environmentId, environments.id))
      .where(eq(environments.organizationId, organizationId))
      .orderBy(environments.name);

    return {
      environments: rows.map((row) => ({
        ...row.environment,
        stack:
          row.stackId && row.stackStatus && row.stackRegion
            ? {
                id: row.stackId,
                status: row.stackStatus,
                region: row.stackRegion,
                lastError: row.stackLastError,
                engineVersion: row.stackEngineVersion,
              }
            : null,
      })),
    };
  }

  /**
   * Delete an environment (its stack row cascades). Refuses production, and
   * refuses anything whose stack has reached real infrastructure.
   *
   * The environment's uploaded publish tarballs go with it. They are deleted
   * AFTER the transaction commits, not inside it: an `rm -r` cannot be rolled
   * back, and a removal that was refused (production, a live stack) or that
   * failed to commit must not have destroyed a tenant's source. The `builds`
   * rows cascade away, so leaving the files would leave them referenced by
   * nothing at all.
   */
  async remove(
    input: RemoveEnvironmentInput,
  ): Promise<RemoveEnvironmentResult> {
    const { organizationId, environmentId, actor } =
      removeInputSchema.parse(input);

    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          environment: environments,
          stackStatus: stacks.status,
        })
        .from(environments)
        .leftJoin(stacks, eq(stacks.environmentId, environments.id))
        .where(
          and(
            eq(environments.id, environmentId),
            // Scoped, so a cross-tenant id reads as "not found" rather than
            // leaking that the row exists somewhere else.
            eq(environments.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundError("Environment", environmentId);

      if (row.environment.kind === "production") {
        throw new ProductionRemovalError(environmentId);
      }
      // A missing stack row is removable — there is nothing provisioned to
      // orphan; any live status is not.
      if (row.stackStatus && !REMOVABLE_STACK_STATUSES.has(row.stackStatus)) {
        throw new StackNotRemovableError(environmentId, row.stackStatus);
      }

      await tx.delete(environments).where(eq(environments.id, environmentId));

      await writeAudit(tx, {
        actor,
        organizationId,
        action: "environment.removed",
        subject: environmentId,
        detail: {
          name: row.environment.name,
          kind: row.environment.kind,
          stackStatus: row.stackStatus,
        },
      });

      // `as const` rather than an inferred literal: assigning the
      // transaction's result to a `const` would widen this to `boolean`, which
      // the declared `RemoveEnvironmentResult` refuses.
      return { removed: true as const };
    });

    // Best-effort: a disk that refuses the delete leaves files an operator can
    // sweep, and must not turn a completed removal into an error.
    await removeEnvironmentArtifacts(environmentId).catch(() => {});

    return result;
  }
}

/** Default instance bound to the app pool — the usual import for callers. */
export const environmentService = new EnvironmentService();
