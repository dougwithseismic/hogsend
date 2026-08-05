import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { type CloudDb, db as defaultDb } from "../db";
import {
  builds,
  cloudPlanEnum,
  organizations,
  stackAlerts,
  stackHealth,
  stackStatusEnum,
  stacks,
} from "../db/schema";
import { getStackAlerts, type StackAlert } from "../pipeline/health-poll";
import { ACTIVE_BUILD_STATUSES } from "../services/builds";
import type { StackStatus } from "../services/stacks";

/**
 * The fleet-stats read behind `GET /api/ops/stats`.
 *
 * One aggregated answer to "is the fleet healthy right now?" — the data all
 * exists already (per-minute `stack_health` observations, the derived alert
 * read, the alert-sweep's memory rows, build rows); this composes it into a
 * single JSON-serializable snapshot. Read-only by construction: nothing here
 * writes, and nothing here reaches a substrate.
 *
 * Count maps are zero-filled over the full enum so the payload SHAPE never
 * depends on the fleet's current state — a consumer alerting on
 * `stacks.byStatus.error > 0` must not break the week no stack is in error.
 */

type CloudPlan = (typeof cloudPlanEnum.enumValues)[number];

/**
 * Every stack status, taken FROM THE SCHEMA rather than retyped here.
 *
 * `satisfies readonly StackStatus[]` on a hand-written list catches a wrong
 * value but not a MISSING one — which is the failure that matters, because the
 * payload's whole promise is that its shape does not depend on the fleet's
 * current state. Reading `stackStatusEnum.enumValues` makes a new status
 * zero-filled automatically, exactly as `cloudPlanEnum.enumValues` already
 * does for plans one line below its use.
 */
const STACK_STATUSES: readonly StackStatus[] = stackStatusEnum.enumValues;

/** Stacks the provision sweep is still responsible for finishing. */
const IN_FLIGHT_STATUSES: readonly StackStatus[] = [
  "requested",
  "provisioning",
];

/** Cap on the errored-stack detail list — a summary, not a paginated browse. */
const ERRORED_STACKS_LIMIT = 20;

export interface OpsStats {
  generatedAt: string;
  stacks: { byStatus: Record<StackStatus, number>; total: number };
  organizations: {
    byPlan: Record<CloudPlan, number>;
    suspended: number;
    total: number;
  };
  health: {
    running: number;
    healthy: number;
    unhealthy: number;
    /** Running stacks the health sweep has never observed. */
    unobserved: number;
    alerts: Array<Omit<StackAlert, "since"> & { since: string }>;
  };
  /** Un-cleared alert-sweep conditions, grouped. */
  openAlerts: Array<{ condition: string; count: number }>;
  provisioning: {
    inFlight: number;
    errored: Array<{
      stackId: string;
      organizationId: string;
      lastError: string | null;
      retryCount: number;
    }>;
  };
  builds: {
    active: number;
    queued: number;
    last24h: { succeeded: number; failed: number };
  };
}

export interface OpsStatsDeps {
  db?: CloudDb;
  now?: () => Date;
}

function zeroFilled<K extends string>(
  keys: readonly K[],
  counted: Array<{ key: K; n: number }>,
): Record<K, number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    K,
    number
  >;
  for (const row of counted) out[row.key] = row.n;
  return out;
}

export async function readOpsStats(deps: OpsStatsDeps = {}): Promise<OpsStats> {
  const db = deps.db ?? defaultDb;
  const now = (deps.now ?? (() => new Date()))();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Most recent observation per stack, same ranked idiom `getStackAlerts`
  // uses (tie broken by id so the verdict is deterministic).
  const latest = db
    .select({
      stackId: stackHealth.stackId,
      healthy: stackHealth.healthy,
      rank: sql<number>`row_number() over (
        partition by ${stackHealth.stackId}
        order by ${stackHealth.checkedAt} desc, ${stackHealth.id} desc
      )`.as("rank"),
    })
    .from(stackHealth)
    .as("latest");

  const [
    stacksByStatus,
    orgsByPlan,
    suspendedOrgs,
    latestHealth,
    streakAlerts,
    openAlertRows,
    erroredStacks,
    buildCounts,
    builds24h,
  ] = await Promise.all([
    db
      .select({ key: stacks.status, n: count() })
      .from(stacks)
      .groupBy(stacks.status),
    db
      .select({ key: organizations.plan, n: count() })
      .from(organizations)
      .groupBy(organizations.plan),
    db
      .select({ n: count() })
      .from(organizations)
      .where(sql`${organizations.suspendedAt} is not null`),
    // Verdict of the most recent observation per RUNNING stack. LEFT JOIN so a
    // running stack the sweep has never seen still counts — as `unobserved`,
    // which is itself a signal (the sweep is not running, or the stack is new).
    db
      .select({ stackId: stacks.id, healthy: latest.healthy })
      .from(stacks)
      .leftJoin(latest, and(eq(latest.stackId, stacks.id), eq(latest.rank, 1)))
      .where(eq(stacks.status, "running")),
    getStackAlerts({}, { db }),
    db
      .select({ condition: stackAlerts.condition, count: count() })
      .from(stackAlerts)
      .where(isNull(stackAlerts.clearedAt))
      .groupBy(stackAlerts.condition),
    db
      .select({
        stackId: stacks.id,
        organizationId: stacks.organizationId,
        lastError: stacks.lastError,
        retryCount: stacks.retryCount,
      })
      .from(stacks)
      .where(eq(stacks.status, "error"))
      .orderBy(desc(stacks.updatedAt))
      .limit(ERRORED_STACKS_LIMIT),
    db
      .select({ key: builds.status, n: count() })
      .from(builds)
      .where(inArray(builds.status, ACTIVE_BUILD_STATUSES))
      .groupBy(builds.status),
    db
      .select({ key: builds.status, n: count() })
      .from(builds)
      .where(
        and(
          inArray(builds.status, ["succeeded", "failed"]),
          gt(builds.finishedAt, dayAgo),
        ),
      )
      .groupBy(builds.status),
  ]);

  const byStatus = zeroFilled(STACK_STATUSES, stacksByStatus);
  const byPlan = zeroFilled(cloudPlanEnum.enumValues, orgsByPlan);
  const activeBuilds = buildCounts.reduce((sum, row) => sum + row.n, 0);
  const queuedBuilds = buildCounts.find((row) => row.key === "queued")?.n ?? 0;
  const terminal24h = zeroFilled(["succeeded", "failed"] as const, builds24h);

  let healthy = 0;
  let unhealthy = 0;
  let unobserved = 0;
  for (const row of latestHealth) {
    if (row.healthy === null) unobserved += 1;
    else if (row.healthy) healthy += 1;
    else unhealthy += 1;
  }

  return {
    generatedAt: now.toISOString(),
    stacks: {
      byStatus,
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
    },
    organizations: {
      byPlan,
      suspended: suspendedOrgs[0]?.n ?? 0,
      total: Object.values(byPlan).reduce((sum, n) => sum + n, 0),
    },
    health: {
      running: latestHealth.length,
      healthy,
      unhealthy,
      unobserved,
      alerts: streakAlerts.map((alert) => ({
        ...alert,
        since: alert.since.toISOString(),
      })),
    },
    openAlerts: openAlertRows.map((row) => ({
      condition: row.condition,
      count: row.count,
    })),
    provisioning: {
      inFlight: IN_FLIGHT_STATUSES.reduce(
        (sum, status) => sum + byStatus[status],
        0,
      ),
      errored: erroredStacks,
    },
    builds: {
      active: activeBuilds,
      queued: queuedBuilds,
      last24h: {
        succeeded: terminal24h.succeeded,
        failed: terminal24h.failed,
      },
    },
  };
}
