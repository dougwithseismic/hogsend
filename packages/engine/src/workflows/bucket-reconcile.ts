import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BucketMeta,
  type ConditionEval,
  type DurationObject,
  durationToMs,
  evaluateCondition,
} from "@hogsend/core";
import {
  bucketMemberships,
  contacts,
  createDatabase,
  type Database,
  userEvents,
} from "@hogsend/db";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getBucketRegistrySingleton } from "../buckets/registry-singleton.js";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import { hatchet } from "../lib/hatchet.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";

/** Chunk size for the composite-only per-member re-evaluation path (Section 6.4). */
const BATCH_SIZE = 500;

/** The reserved prefix every bucket transition event carries. */
const BUCKET_EVENT_PREFIX = "bucket:";

/**
 * Engine-owned cron reconciliation for TIME-BASED bucket leaves (Section 6.4).
 *
 * Time-based criteria (an `EventCondition.within` rolling window) silently flip a
 * user OUT of a bucket as the clock advances with NO inbound event — the real-time
 * path structurally cannot catch this. This cron sweeps every `timeBased`,
 * `kind:"dynamic"` bucket and transitions members who SHOULD leave via a single
 * set-based SHOULD-LEAVE query (per criterion shape) + a bulk compare-and-swap.
 *
 * It self-bootstraps `db`/`logger` from `process.env` (cron runs have no request
 * container), cloned from `check-alerts.ts`, and reads the process bucket-registry
 * singleton (installed by `createHogsendClient`, which both API and worker call).
 *
 * Emission is gated on the `RETURNING` of the bulk CAS — the loser of a concurrent
 * race (e.g. an overlapping ingest tick) mutates zero rows and never emits — and it
 * reuses the SAME deterministic `idempotencyKey` shape as the real-time path
 * (`bucket:<id>:<userId>:<kind>:<entryCount>`), so concurrent ingest + cron
 * converge to exactly ONE emission (Section 6.3 worked example).
 *
 * NON-cancelling concurrency: a sweep that overruns the interval must be allowed to
 * FINISH (else an expiration never completes and members are stuck `active`
 * forever), so the strategy is `GROUP_ROUND_ROBIN` with `maxRuns: 1` keyed on a
 * single static group — a newcomer queues behind the incumbent, it is never
 * cancelled (NOT `CANCEL_IN_PROGRESS`).
 */
export const bucketReconcileTask = hatchet.task({
  name: "bucket-reconcile",
  onCrons: [process.env.BUCKET_RECONCILE_CRON ?? "*/5 * * * *"],
  retries: 1,
  executionTimeout: "120s",
  concurrency: {
    // Single global key → at most one sweep runs; the next one QUEUES (round
    // robin) rather than cancelling the in-flight run.
    expression: "'bucket-reconcile'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: async () => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const registry = getBucketRegistrySingleton();
    const journeyRegistry = getJourneyRegistrySingleton();

    let reconciled = 0;
    let joined = 0;

    for (const bucket of registry.getEnabled()) {
      // kind:"manual" buckets are NEVER auto-recomputed (early-continue).
      if (bucket.kind === "manual" || !bucket.criteria) continue;
      // Only TIME-BASED, dynamic buckets — the only kind a clock can change.
      // timeBased is honoured explicitly OR inferred from a `within` window.
      if (!isTimeBased(bucket)) continue;

      try {
        const left = await reconcileBucketLeaves({
          db,
          logger,
          journeyRegistry,
          bucket,
        });
        reconciled += left;

        // reconcileJoins (default off) materializes absence joins the real-time
        // path cannot see (e.g. went-dormant — the NOT-EXISTS-within-window
        // case). Kept off for non-absence buckets to bound cost (Section 6.4).
        if (bucket.reconcileJoins) {
          joined += await reconcileBucketJoins({
            db,
            logger,
            journeyRegistry,
            bucket,
          });
        }
      } catch (err) {
        logger.error("Bucket reconcile failed", {
          bucketId: bucket.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info("Bucket reconcile sweep complete", { reconciled, joined });
    return { reconciled, joined };
  },
});

/**
 * Optional per-user fast-expiry durable timer (Section 6.5). Armed on JOIN for
 * `meta.fastExpiry` buckets, it durably sleeps until the membership's `expiresAt`
 * deadline, then leaves via a SINGLE atomic CAS keyed on the ARMED `expiresAt` —
 * never read-then-act. A concurrent real-time event that re-armed the window (a new
 * `expiresAt`) makes the CAS match zero rows, so the stale timer no-ops WITHOUT
 * emitting a spurious `bucket:left`. The cron remains the authoritative backstop
 * for any timer lost to worker churn.
 *
 * It is a single SHARED durableTask keyed on `bucket:arm-expiry` (per-bucket arming
 * is by event payload, not per-bucket task instances), registered once by
 * `selectBucketTasks` if ANY enabled bucket opts in (Section 9.4). The
 * `bucket:`-prefixed event name is recursion-guarded by `checkBucketMembership`.
 */
export interface BucketArmExpiryInput extends JsonObject {
  rowId: string;
  bucketId: string;
  userId: string;
  userEmail: string | null;
  /** ISO timestamp of the armed deadline — the CAS epoch. */
  armedExpiresAt: string;
  /** ms from arming to the deadline (the durable sleep). */
  msUntilExpiry: number;
}

export const bucketExpiryTask = hatchet.durableTask({
  name: "bucket-expiry",
  onEvents: [`${BUCKET_EVENT_PREFIX}arm-expiry`],
  retries: 0,
  fn: async (input: BucketArmExpiryInput, ctx) => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const registry = getBucketRegistrySingleton();
    const journeyRegistry = getJourneyRegistrySingleton();

    // Durable sleep to the deadline. Hatchet's sleepFor accepts a ms number.
    await ctx.sleepFor(input.msUntilExpiry);

    const bucket = registry.get(input.bucketId);
    if (!bucket?.criteria) {
      return { status: "skipped", reason: "bucket_unregistered" };
    }

    // On wake, re-confirm the criteria still says "should leave". If the user
    // re-qualified (e.g. fired the event again), do not leave.
    const stillMember = await evaluateCondition({
      condition: bucket.criteria,
      ctx: { db, userId: input.userId, journeyContext: {} },
    });
    if (stillMember) {
      return { status: "skipped", reason: "still_member" };
    }

    // SINGLE atomic CAS keyed on the ARMED expiresAt — a re-armed window (new
    // expiresAt) makes this match zero rows → no spurious leave (Section 6.5).
    const left = await db
      .update(bucketMemberships)
      .set({
        status: "left",
        leftAt: new Date(),
        lastEvaluatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bucketMemberships.id, input.rowId),
          eq(bucketMemberships.status, "active"),
          eq(bucketMemberships.expiresAt, new Date(input.armedExpiresAt)),
        ),
      )
      .returning({
        id: bucketMemberships.id,
        entryCount: bucketMemberships.entryCount,
      });

    const flipped = left[0];
    if (!flipped) {
      return { status: "skipped", reason: "re_armed_or_already_left" };
    }

    await emitBucketTransition({
      db,
      registry: journeyRegistry,
      hatchet,
      logger,
      kind: "left",
      bucket,
      userId: input.userId,
      userEmail: input.userEmail,
      epoch: flipped.entryCount,
      source: "reconcile",
    });

    return { status: "left", rowId: flipped.id };
  },
});

/**
 * Set-based SHOULD-LEAVE for one time-based bucket → bulk CAS → RETURNING-gated
 * emit. For single-event `not_exists`/`exists`/`count within` criteria the
 * SHOULD-LEAVE SQL IS the authoritative evaluation (NO per-member
 * `evaluateCondition`). Composite/multi-condition time-based buckets fall back to a
 * chunked per-member `evaluateCondition` loop keyed on `lastEvaluatedAt`.
 */
async function reconcileBucketLeaves(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;
  const criteria = bucket.criteria as ConditionEval;

  // A single-event/within/count criterion → set-based SHOULD-LEAVE query.
  if (criteria.type === "event") {
    const leaverIds = await selectEventLeavers(db, bucket, criteria);
    if (leaverIds.length === 0) return 0;
    return bulkLeave({
      db,
      logger,
      journeyRegistry,
      bucket,
      userIds: leaverIds,
    });
  }

  // composite/multi-condition → chunked per-member evaluateCondition (the
  // documented O(active members) fallback, Section 6.4).
  return reconcileCompositeLeaves({ db, logger, journeyRegistry, bucket });
}

/**
 * The SHOULD-LEAVE user-id set for a single-event time-based criterion, matched to
 * the criterion SHAPE (a single `NOT EXISTS` is WRONG for count/exists — Section
 * 6.4). Returns active members who SHOULD leave (the set is a superset of real
 * leavers; never misses one).
 */
async function selectEventLeavers(
  db: Database,
  bucket: BucketMeta,
  criteria: Extract<ConditionEval, { type: "event" }>,
): Promise<string[]> {
  const cutoff = criteria.within
    ? new Date(Date.now() - durationToMs(criteria.within))
    : null;

  // Active members of this bucket whose contact is live (GDPR — Section 8.6).
  const members = db
    .select({ userId: bucketMemberships.userId })
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    )
    .as("members");

  // The windowed count of the criterion's event per member, set-based.
  const counted = db
    .select({
      userId: userEvents.userId,
      cnt: sql<number>`count(*)::int`.as("cnt"),
    })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.event, criteria.eventName),
        cutoff ? gte(userEvents.occurredAt, cutoff) : undefined,
      ),
    )
    .groupBy(userEvents.userId)
    .as("counted");

  // LEFT JOIN members → windowed counts. A missing/zero count is a 0.
  const rows = await db
    .select({
      userId: members.userId,
      cnt: sql<number>`coalesce(${counted.cnt}, 0)`,
    })
    .from(members)
    .leftJoin(counted, eq(members.userId, counted.userId))
    .innerJoin(contacts, eq(contacts.externalId, members.userId))
    .where(isNull(contacts.deletedAt));

  return rows
    .filter((r) => shouldLeaveByCount(criteria, Number(r.cnt)))
    .map((r) => r.userId);
}

/**
 * SHOULD-LEAVE decision from the windowed count, per criterion shape (Section
 * 6.4). A member is a leaver when the criterion is NO LONGER satisfied.
 */
function shouldLeaveByCount(
  criteria: Extract<ConditionEval, { type: "event" }>,
  windowedCount: number,
): boolean {
  switch (criteria.check) {
    case "not_exists":
      // Absence bucket: SHOULD LEAVE when an event REAPPEARS in the window.
      return windowedCount > 0;
    case "exists":
      // Positive existence: SHOULD LEAVE when NOT EXISTS in the window.
      return windowedCount === 0;
    case "count": {
      // SHOULD LEAVE when the windowed count NO LONGER satisfies the operator.
      if (!criteria.operator || criteria.value === undefined) {
        return windowedCount === 0;
      }
      switch (criteria.operator) {
        case "gt":
          return !(windowedCount > criteria.value);
        case "gte":
          return !(windowedCount >= criteria.value);
        case "lt":
          return !(windowedCount < criteria.value);
        case "lte":
          return !(windowedCount <= criteria.value);
        case "eq":
          return !(windowedCount === criteria.value);
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Composite/multi-condition time-based fallback — chunked per-member
 * `evaluateCondition` keyed on `lastEvaluatedAt` so the oldest-evaluated members
 * are swept first and the run is bounded by `BATCH_SIZE` (Section 6.4).
 */
async function reconcileCompositeLeaves(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;
  const criteria = bucket.criteria as ConditionEval;

  const members = await db
    .select({
      userId: bucketMemberships.userId,
    })
    .from(bucketMemberships)
    .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
    .where(
      and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        isNull(contacts.deletedAt),
      ),
    )
    .orderBy(sql`${bucketMemberships.lastEvaluatedAt} asc nulls first`)
    .limit(BATCH_SIZE);

  const leaverIds: string[] = [];
  const evaluatedIds: string[] = [];
  for (const member of members) {
    evaluatedIds.push(member.userId);
    const isMember = await evaluateCondition({
      condition: criteria,
      ctx: { db, userId: member.userId, journeyContext: {} },
    });
    if (!isMember) leaverIds.push(member.userId);
  }

  // Bump lastEvaluatedAt for the whole chunk so the next tick advances the cursor
  // (including stable members, which are NOT leavers).
  if (evaluatedIds.length > 0) {
    await db
      .update(bucketMemberships)
      .set({ lastEvaluatedAt: new Date() })
      .where(
        and(
          eq(bucketMemberships.bucketId, bucket.id),
          eq(bucketMemberships.status, "active"),
          inArray(bucketMemberships.userId, evaluatedIds),
        ),
      );
  }

  if (leaverIds.length === 0) return 0;
  return bulkLeave({ db, logger, journeyRegistry, bucket, userIds: leaverIds });
}

/**
 * Bulk compare-and-swap a set of active members to `left`, then emit `bucket:left`
 * for each row the UPDATE actually flipped (gated on RETURNING — the loser of a
 * concurrent race mutates zero rows and never emits, Section 6.3). minDwell defers:
 * a member still inside its dwell window is NOT left here (the dwell deadline is
 * carried on `expiresAt`; the next eligible tick leaves it).
 */
async function bulkLeave(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
  userIds: string[];
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket, userIds } = opts;

  const dwellMs = bucket.minDwell ? durationToMs(bucket.minDwell) : 0;
  const dwellCutoff = dwellMs > 0 ? new Date(Date.now() - dwellMs) : null;

  // Flip only active rows for the leaver set whose minDwell has elapsed. The CAS
  // guard (status = 'active') means a concurrent leave makes this affect zero of
  // those rows. RETURNING carries userEmail + entryCount for the emit.
  const flipped = await db
    .update(bucketMemberships)
    .set({
      status: "left",
      leftAt: new Date(),
      lastEvaluatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        inArray(bucketMemberships.userId, userIds),
        // minDwell: only leave rows that have existed at least minDwell.
        dwellCutoff ? lte(bucketMemberships.enteredAt, dwellCutoff) : undefined,
      ),
    )
    .returning({
      id: bucketMemberships.id,
      userId: bucketMemberships.userId,
      userEmail: bucketMemberships.userEmail,
      entryCount: bucketMemberships.entryCount,
    });

  for (const row of flipped) {
    await emitBucketTransition({
      db,
      registry: journeyRegistry,
      hatchet,
      logger,
      kind: "left",
      bucket,
      userId: row.userId,
      userEmail: row.userEmail,
      epoch: row.entryCount,
      source: "reconcile",
    });
  }

  return flipped.length;
}

/**
 * reconcileJoins (absence buckets): materialize NEW members the real-time path
 * cannot see. For a `not_exists within W` (absence) criterion, a user JOINS when
 * they have NO such event in the window — i.e. the set-based JOIN query. Inserts a
 * fresh active row (RETURNING-gated, partial-active unique index) and emits
 * `bucket:entered` for each genuine new member.
 */
async function reconcileBucketJoins(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;
  const criteria = bucket.criteria as ConditionEval;

  // Only single-event absence criteria have a tractable set-based JOIN query; the
  // composite/positive cases are already caught real-time on event arrival.
  if (criteria.type !== "event" || criteria.check !== "not_exists") {
    return 0;
  }

  const cutoff = criteria.within
    ? new Date(Date.now() - durationToMs(criteria.within))
    : null;

  // Users who have fired the event inside the window (they are NOT candidates).
  const present = db
    .select({ userId: userEvents.userId })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.event, criteria.eventName),
        cutoff ? gte(userEvents.occurredAt, cutoff) : undefined,
      ),
    )
    .groupBy(userEvents.userId)
    .as("present");

  // Users who already have an active membership (skip — they are members).
  const activeMembers = db
    .select({ userId: bucketMemberships.userId })
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
      ),
    )
    .as("active_members");

  // Candidates: live contacts NOT present in the window AND not already members.
  const candidates = await db
    .select({
      userId: contacts.externalId,
      email: contacts.email,
    })
    .from(contacts)
    .leftJoin(present, eq(present.userId, contacts.externalId))
    .leftJoin(activeMembers, eq(activeMembers.userId, contacts.externalId))
    .where(
      and(
        isNull(contacts.deletedAt),
        isNull(present.userId),
        isNull(activeMembers.userId),
      ),
    )
    .limit(BATCH_SIZE);

  let joined = 0;
  for (const candidate of candidates) {
    const transitioned = await reconcileJoinOne({
      db,
      logger,
      journeyRegistry,
      bucket,
      userId: candidate.userId,
      userEmail: candidate.email ?? null,
    });
    if (transitioned) joined += 1;
  }
  return joined;
}

/**
 * Insert ONE reconcile-discovered join (RETURNING-gated on the partial-active
 * unique index) and emit `bucket:entered`. entryCount = 1 + prior memberships.
 */
async function reconcileJoinOne(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
  userId: string;
  userEmail: string | null;
}): Promise<boolean> {
  const { db, logger, journeyRegistry, bucket, userId, userEmail } = opts;

  const [counted] = await db
    .select({ priorCount: sql<number>`count(*)::int` })
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.userId, userId),
        eq(bucketMemberships.bucketId, bucket.id),
      ),
    );
  const priorCount = Number(counted?.priorCount ?? 0);
  const epoch = priorCount + 1;

  const inserted = await db
    .insert(bucketMemberships)
    .values({
      userId,
      userEmail,
      bucketId: bucket.id,
      status: "active",
      source: "reconcile",
      entryCount: epoch,
      expiresAt: computeReconcileExpiresAt(bucket),
      lastEvaluatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: bucketMemberships.id });

  if (inserted.length !== 1) {
    return false;
  }

  await emitBucketTransition({
    db,
    registry: journeyRegistry,
    hatchet,
    logger,
    kind: "entered",
    bucket,
    userId,
    userEmail,
    epoch,
    source: "reconcile",
  });

  return true;
}

/** now + within for time-based / fastExpiry buckets; null otherwise. */
function computeReconcileExpiresAt(bucket: BucketMeta): Date | null {
  if (!bucket.criteria) return null;
  if (!bucket.timeBased && !bucket.fastExpiry) return null;
  const within = firstWithin(bucket.criteria);
  if (!within) return null;
  return new Date(Date.now() + durationToMs(within));
}

/** A bucket is time-based if flagged OR its criteria carry a `within` window. */
function isTimeBased(bucket: BucketMeta): boolean {
  if (bucket.timeBased) return true;
  if (!bucket.criteria) return false;
  return firstWithin(bucket.criteria) != null;
}

/** Find the first EventCondition.within in a criteria tree (depth-first). */
function firstWithin(criteria: ConditionEval): DurationObject | null {
  if (criteria.type === "event" && criteria.within) {
    return criteria.within;
  }
  if (criteria.type === "composite") {
    for (const child of criteria.conditions) {
      const found = firstWithin(child);
      if (found) return found;
    }
  }
  return null;
}
