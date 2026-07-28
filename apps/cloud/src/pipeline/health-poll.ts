import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { stackHealth, stacks } from "../db/schema";
import type { StackRow } from "../services/orgs";
import {
  getSubstrate,
  type StackRefs,
  type SubstrateProvider,
} from "../substrate";

/**
 * The health poll: a recurring sweep of every `running` stack, and the alert
 * state derived from what it recorded.
 *
 * The laws (PRD 04 EARS: "unhealthy 3 consecutive sweeps → dashboard alert
 * state, NO auto-transition"):
 *
 *  - **The sweep never transitions a stack.** It writes `stack_health` rows and
 *    nothing else. A sick stack stays `running`, because a poll is an
 *    observation and suspending someone's production instance on three failed
 *    HTTP checks is an operator's decision, not a cron's.
 *  - **An alert is DERIVED, never stored.** `getStackAlerts` reads the three
 *    most recent observations per stack; there is no alert table to go stale,
 *    and a single healthy sweep clears the alert by simply being the newest row.
 *  - **One sick stack never fails the sweep.** A substrate that throws is
 *    recorded as an unhealthy observation for THAT stack and the loop carries
 *    on — otherwise the first broken tenant would blind the poll to every other.
 */

/** Consecutive unhealthy observations that raise the dashboard alert. */
export const UNHEALTHY_ALERT_STREAK = 3;

/** The Hatchet cron: every minute, the finest granularity cron expresses. */
export const HEALTH_SWEEP_CRON = "* * * * *";

export interface HealthPollDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  /** Injected so a test can order observations deterministically. */
  now: () => Date;
}

function defaultDeps(): HealthPollDeps {
  return { db: defaultDb, substrate: getSubstrate(), now: () => new Date() };
}

export interface StackHealthObservation {
  stackId: string;
  organizationId: string;
  healthy: boolean;
  detail: string | null;
  checkedAt: Date;
}

export interface SweepResult {
  checked: number;
  healthy: number;
  unhealthy: number;
  observations: StackHealthObservation[];
}

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

/** `detail` is an operator hint on a row read in a list; keep it short. */
const MAX_DETAIL_LENGTH = 500;

/**
 * Ask the substrate about every `running` stack and record what it said.
 *
 * Exported for direct invocation as well as registered as a Hatchet cron: dev
 * (no Hatchet) and tests call this function, production calls the same function
 * through the durable task, and there is exactly one implementation either way.
 */
export async function sweepStackHealth(
  overrides: Partial<HealthPollDeps> = {},
): Promise<SweepResult> {
  const deps: HealthPollDeps = { ...defaultDeps(), ...overrides };

  const running = await deps.db
    .select()
    .from(stacks)
    .where(eq(stacks.status, "running"));

  const observations: StackHealthObservation[] = [];

  for (const stack of running) {
    const checkedAt = deps.now();
    const refs = readRefs(stack);

    let healthy = false;
    let detail: string | null = null;

    if (!refs) {
      // A `running` stack with no substrate handle is not healthy by any
      // reading — it is a row claiming an instance nobody can reach.
      detail = "stack has no substrate refs";
    } else {
      try {
        const result = await deps.substrate.getHealth(refs);
        healthy = result.healthy;
        detail = result.detail ?? null;
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
    }

    const observation: StackHealthObservation = {
      stackId: stack.id,
      organizationId: stack.organizationId,
      healthy,
      detail: detail ? detail.slice(0, MAX_DETAIL_LENGTH) : null,
      checkedAt,
    };
    await deps.db.insert(stackHealth).values(observation);
    observations.push(observation);
  }

  return {
    checked: observations.length,
    healthy: observations.filter((row) => row.healthy).length,
    unhealthy: observations.filter((row) => !row.healthy).length,
    observations,
  };
}

export interface StackAlert {
  stackId: string;
  organizationId: string;
  /** Consecutive unhealthy observations, most recent first. */
  streak: number;
  /** The newest unhealthy reason, for the dashboard line. */
  detail: string | null;
  since: Date;
}

/**
 * The stacks currently in alert: `running`, with the {@link
 * UNHEALTHY_ALERT_STREAK} most recent observations ALL unhealthy.
 *
 * One query, not one per stack: the window function ranks each stack's
 * observations newest-first and the outer filter keeps only the top three, so
 * the cost is bounded by (stacks × 3) rather than by the whole history.
 */
export async function getStackAlerts(
  input: { organizationId?: string } = {},
  overrides: Partial<Pick<HealthPollDeps, "db">> = {},
): Promise<StackAlert[]> {
  const db = overrides.db ?? defaultDb;

  const ranked = db
    .select({
      stackId: stackHealth.stackId,
      organizationId: stackHealth.organizationId,
      healthy: stackHealth.healthy,
      detail: stackHealth.detail,
      checkedAt: stackHealth.checkedAt,
      // `id` breaks a checked_at tie deterministically; without it two
      // observations written in the same millisecond could rank arbitrarily
      // and make the streak read differently on two runs of one query.
      rank: sql<number>`row_number() over (
        partition by ${stackHealth.stackId}
        order by ${stackHealth.checkedAt} desc, ${stackHealth.id} desc
      )`.as("rank"),
    })
    .from(stackHealth)
    .as("ranked");

  const rows = await db
    .select({
      stackId: ranked.stackId,
      organizationId: ranked.organizationId,
      healthy: ranked.healthy,
      detail: ranked.detail,
      checkedAt: ranked.checkedAt,
    })
    .from(ranked)
    // Alerts are about LIVE stacks. A suspended or destroyed stack keeps its
    // history but must not keep alerting about a health nobody expects.
    .innerJoin(stacks, eq(stacks.id, ranked.stackId))
    .where(
      and(
        lte(ranked.rank, UNHEALTHY_ALERT_STREAK),
        eq(stacks.status, "running"),
        input.organizationId
          ? eq(ranked.organizationId, input.organizationId)
          : undefined,
      ),
    )
    .orderBy(ranked.stackId, desc(ranked.checkedAt));

  const byStack = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byStack.get(row.stackId) ?? [];
    bucket.push(row);
    byStack.set(row.stackId, bucket);
  }

  const alerts: StackAlert[] = [];
  for (const [stackId, bucket] of byStack) {
    // Fewer than the streak means the stack has not been observed enough times
    // to have failed three IN A ROW — a fresh stack must not alert on its
    // first bad sweep.
    if (bucket.length < UNHEALTHY_ALERT_STREAK) continue;
    if (bucket.some((row) => row.healthy)) continue;

    const newest = bucket[0];
    const oldest = bucket[bucket.length - 1];
    if (!newest || !oldest) continue;
    alerts.push({
      stackId,
      organizationId: newest.organizationId,
      streak: bucket.length,
      detail: newest.detail,
      since: oldest.checkedAt,
    });
  }

  return alerts;
}
