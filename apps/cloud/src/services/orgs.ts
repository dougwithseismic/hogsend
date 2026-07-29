import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { cells, environments, organizations, stacks } from "../db/schema";
import { type CloudWriter, writeAudit } from "./audit";
import { IllegalRegionError, NotFoundError } from "./errors";

/**
 * Tenant roots: the mirror of a Better Auth organization plus the placement
 * decision that fixes where its infrastructure lives.
 *
 * The invariants this service exists to hold:
 *  - an organization is NEVER half-created — the org row, its `production`
 *    environment and that environment's stack land in ONE transaction, so a
 *    failed placement leaves no orphan tenant for a human to clean up;
 *  - placement is a RULE, not a preference: a shared-tier tenant must land on an
 *    accepting cell in its own region with spare capacity, or the signup is
 *    refused (`IllegalRegionError`). A dedicated tenant gets its own substrate
 *    and so carries `cell_id = null` and may pick any region;
 *  - stacks are only ever BORN here, in `requested`. This module never
 *    transitions a status — that is `StackService.transition()`'s sole right
 *    (PRD 02 task 4).
 */

/** DECISIONS §2: trial 1 (prod) / self-serve 2 / dedicated 4. */
export const PLAN_ENVIRONMENT_LIMITS = {
  trial: 1,
  self_serve: 2,
  dedicated: 4,
} as const satisfies Record<CloudPlan, number>;

/** Plans that live on shared cell infrastructure and so need placement. */
const SHARED_TIER_PLANS = new Set(["trial", "self_serve"]);

/** DECISIONS §2: the trial clock. */
const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;

/** Postgres caps identifiers at 63 bytes; a longer db name would be truncated
 * silently by the server and two tenants could then collide. */
const MAX_DB_NAME_LENGTH = 63;

const regionSchema = z.enum(["us", "eu"]);
const planSchema = z.enum(["trial", "self_serve", "dedicated"]);
const actorSchema = z.string().min(1).max(200);

export type CloudRegion = z.infer<typeof regionSchema>;
export type CloudPlan = z.infer<typeof planSchema>;

const createInputSchema = z.object({
  /** Better Auth's organization id — the tenant identifier, not a fresh uuid. */
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  region: regionSchema,
  plan: planSchema.default("trial"),
  actor: actorSchema.optional(),
});

const idInputSchema = z.object({
  id: z.string().min(1).max(200),
  actor: actorSchema.optional(),
});

/**
 * Why a tenant is stopped. `billing` is the ONLY reason `PlanService` will lift
 * on its own; every other stop (an ops/abuse one) is a human's to undo.
 */
export const SUSPENSION_REASONS = ["billing", "abuse"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

const suspendInputSchema = idInputSchema.extend({
  reason: z.enum(SUSPENSION_REASONS).optional(),
});

export type CreateOrgInput = z.input<typeof createInputSchema>;
export type OrgTargetInput = z.input<typeof idInputSchema>;
export type SuspendOrgInput = z.input<typeof suspendInputSchema>;

export type OrganizationRow = typeof organizations.$inferSelect;
export type EnvironmentRow = typeof environments.$inferSelect;
export type StackRow = typeof stacks.$inferSelect;

export interface CreateOrgResult {
  organization: OrganizationRow;
  environment: EnvironmentRow;
  stack: StackRow;
}

export type GetOrgResult =
  | {
      found: true;
      organization: OrganizationRow;
      environments: EnvironmentRow[];
    }
  | { found: false };

export type SuspendOrgResult = { organization: OrganizationRow };

/**
 * `hs_<org>_<environment>`, lowercased with every non-identifier character
 * folded to `_`, clipped to Postgres' 63-byte identifier limit.
 */
export function buildStackDbName(
  organizationId: string,
  environmentName: string,
): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  return `hs_${slug(organizationId)}_${slug(environmentName)}`.slice(
    0,
    MAX_DB_NAME_LENGTH,
  );
}

/**
 * Insert an environment + its `requested` stack. Shared with
 * `EnvironmentService` so BOTH creation paths produce an identical row shape —
 * the production environment minted at signup must not be a special case the
 * provisioner has to know about.
 *
 * The stack id is generated up front because `hatchet_namespace` IS the stack id
 * (the per-stack Hatchet isolation handle, DECISIONS §3), so the row must know
 * its own id before the INSERT rather than after.
 */
export async function insertEnvironmentWithStack(
  writer: CloudWriter,
  input: {
    organizationId: string;
    name: string;
    kind: "production" | "staging" | "test";
    region: CloudRegion;
  },
): Promise<{ environment: EnvironmentRow; stack: StackRow }> {
  const [environment] = await writer
    .insert(environments)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      kind: input.kind,
    })
    .returning();
  if (!environment) {
    throw new Error(
      `Failed to create environment "${input.name}" for ${input.organizationId}`,
    );
  }

  const stackId = randomUUID();
  const [stack] = await writer
    .insert(stacks)
    .values({
      id: stackId,
      organizationId: input.organizationId,
      environmentId: environment.id,
      // Task 4 owns every later status; birth is the one write that is ours.
      status: "requested",
      region: input.region,
      hatchetNamespace: stackId,
      dbName: buildStackDbName(input.organizationId, input.name),
    })
    .returning();
  if (!stack) {
    throw new Error(`Failed to create stack for environment ${environment.id}`);
  }

  return { environment, stack };
}

export class OrgService {
  constructor(private readonly db: CloudDb = defaultDb) {}

  /**
   * Place, then create the whole tenant atomically: org + `production`
   * environment + `requested` stack + audit row, in one transaction.
   */
  async create(input: CreateOrgInput): Promise<CreateOrgResult> {
    const { id, name, region, plan, actor } = createInputSchema.parse(input);

    return this.db.transaction(async (tx) => {
      const cellId = SHARED_TIER_PLANS.has(plan)
        ? await placeOnCell(tx, region, plan)
        : null;

      const [organization] = await tx
        .insert(organizations)
        .values({
          id,
          name,
          region,
          plan,
          cellId,
          // The clock belongs to the trial alone — a paid org that started as a
          // trial must not keep a stale expiry hanging off it.
          trialEndsAt:
            plan === "trial"
              ? new Date(Date.now() + TRIAL_DAYS * DAY_MS)
              : null,
        })
        .returning();
      if (!organization) {
        throw new Error(`Failed to create organization ${id}`);
      }

      const { environment, stack } = await insertEnvironmentWithStack(tx, {
        organizationId: id,
        name: "production",
        kind: "production",
        region,
      });

      await writeAudit(tx, {
        actor,
        organizationId: id,
        action: "org.created",
        subject: id,
        detail: {
          region,
          plan,
          cellId,
          environmentId: environment.id,
          stackId: stack.id,
        },
      });

      return { organization, environment, stack };
    });
  }

  /** The org plus its environments — the dashboard's root read. */
  async get(input: { id: string }): Promise<GetOrgResult> {
    const { id } = idInputSchema.parse(input);

    const [organization] = await this.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    if (!organization) return { found: false };

    const rows = await this.db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, id))
      .orderBy(environments.name);

    return { found: true, organization, environments: rows };
  }

  /**
   * Billing/ops stop. Data is kept; PRD 06 drives what suspension DOES.
   *
   * `reason` is what makes the stop reversible by the right party — only
   * `PlanService` lifts a `billing` one, and an ops stop (no reason) stays put
   * however much the tenant pays.
   */
  async suspend(input: SuspendOrgInput): Promise<SuspendOrgResult> {
    return this.setSuspended(input, new Date());
  }

  /** Clears the suspension flag. Idempotent — re-clearing is not an error. */
  async unsuspend(input: OrgTargetInput): Promise<SuspendOrgResult> {
    return this.setSuspended(input, null);
  }

  private async setSuspended(
    input: SuspendOrgInput,
    suspendedAt: Date | null,
  ): Promise<SuspendOrgResult> {
    const { id, actor, reason } = suspendInputSchema.parse(input);

    const [organization] = await this.db
      .update(organizations)
      .set({
        suspendedAt,
        // The reason lives and dies WITH the suspension: a lifted stop that
        // kept its reason would make the next `billing` check read a stale one.
        suspendedReason: suspendedAt ? (reason ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, id))
      .returning();
    if (!organization) throw new NotFoundError("Organization", id);

    await writeAudit(this.db, {
      actor,
      organizationId: id,
      action: suspendedAt ? "org.suspended" : "org.unsuspended",
      subject: id,
      detail: {
        suspendedAt: suspendedAt?.toISOString() ?? null,
        reason: organization.suspendedReason,
      },
    });

    return { organization };
  }
}

/**
 * Pick an accepting cell in `region` with spare capacity.
 *
 * The candidate rows are locked FOR UPDATE so two concurrent signups cannot both
 * read "99 of 100" and both land — the second waits, then re-counts and sees the
 * first. Ordering by name makes placement deterministic (and the lock order
 * stable, so two placers in different regions can never deadlock each other).
 */
async function placeOnCell(
  writer: CloudWriter,
  region: CloudRegion,
  plan: CloudPlan,
): Promise<string> {
  const candidates = await writer
    .select({ id: cells.id, name: cells.name, maxTenants: cells.maxTenants })
    .from(cells)
    .where(and(eq(cells.region, region), eq(cells.accepting, true)))
    .orderBy(cells.name)
    .for("update");

  if (candidates.length === 0) throw new IllegalRegionError(region, plan);

  const counts = await writer
    .select({ cellId: organizations.cellId, tenants: count() })
    .from(organizations)
    .where(
      inArray(
        organizations.cellId,
        candidates.map((c) => c.id),
      ),
    )
    .groupBy(organizations.cellId);

  const byCell = new Map(counts.map((row) => [row.cellId, row.tenants]));
  const target = candidates.find(
    (cell) => (byCell.get(cell.id) ?? 0) < cell.maxTenants,
  );
  if (!target) throw new IllegalRegionError(region, plan);

  return target.id;
}

/** Default instance bound to the app pool — the usual import for callers. */
export const orgService = new OrgService();
