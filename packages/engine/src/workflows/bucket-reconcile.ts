import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BucketMeta,
  type ConditionEval,
  collectPropertyNames,
  durationToMs,
  evaluateCondition,
} from "@hogsend/core";
import type { JourneyMeta } from "@hogsend/core/types";
import {
  bucketConfigs,
  bucketMemberships,
  contacts,
  createDatabase,
  type Database,
  importJobs,
  userEvents,
} from "@hogsend/db";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { BucketLeaveReason } from "../buckets/bucket-reactions.js";
import { shouldEmitJoin } from "../buckets/check-membership.js";
import {
  BUCKET_EVENT_PREFIX,
  computeExpiresAt,
  computeMaxDwellAt,
  countPriorMemberships,
  firstWithin,
  shouldLeaveByCount,
} from "../buckets/membership-epoch.js";
import { getBucketRegistrySingleton } from "../buckets/registry-singleton.js";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import { contactKeySql, normalizeEmailOrNull } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";
import { toSleepDuration } from "../lib/hatchet-duration.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";
import { FIRST_TIME_FORMAT } from "./bucket-backfill.js";

/** Chunk size for the composite-only per-member re-evaluation path (Section 6.4). */
const BATCH_SIZE = 500;

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

      // Process a bucket here iff a clock can flip its membership OR fire a
      // membership-age dwell: a TIME-BASED criteria window (criteria-driven
      // leaves/joins), an unconditional `maxDwell` TTL (membership-age-driven
      // leaves), OR a `dwell` reaction (membership-age-driven fire). timeBased is
      // honoured explicitly OR inferred from a `within` window. The dwell-only
      // bucket falls through and runs ONLY the dwell pass (the criteria pass is
      // behind `if (timeBased)`, the TTL pass behind `if (bucket.maxDwell)`).
      const timeBased = isTimeBased(bucket);
      const dwellReactions = journeyRegistry
        .getAll()
        .filter(
          (j) => j.sourceBucketId === bucket.id && j.reactionKind === "dwell",
        );
      const hasDwell = dwellReactions.length > 0;
      if (!timeBased && !bucket.maxDwell && !hasDwell) continue;

      try {
        if (timeBased) {
          reconciled += await reconcileBucketLeaves({
            db,
            logger,
            journeyRegistry,
            bucket,
          });

          // reconcileJoins materializes absence joins the real-time path
          // cannot see (e.g. went-dormant — the NOT-EXISTS-within-window case).
          // An explicit `reconcileJoins` overrides; when omitted it is INFERRED
          // true ONLY for the two SAFE set-based shapes — a single-event windowed
          // `not_exists` and the lapsed-active composite (Fix #3) — whose SQL
          // candidate set is exact. Other absence composites (OR-of-absence,
          // absence + property/count) need an explicit opt-in and run the
          // BATCH_SIZE-bounded per-member confirm, keeping the sweep O(active
          // members) for everything else (Section 6.4).
          if (shouldReconcileJoins(bucket)) {
            joined += await reconcileBucketJoins({
              db,
              logger,
              journeyRegistry,
              bucket,
            });
          }
        }

        // Unconditional max-dwell TTL: force-leave members past
        // enteredAt + maxDwell REGARDLESS of whether criteria still match. Runs
        // for time-based AND pure-property dynamic buckets. Re-entry afterwards
        // is governed by the bucket's `entryLimit` policy (per-bucket time-box vs
        // periodic flush).
        if (bucket.maxDwell) {
          reconciled += await reconcileBucketTtlLeaves({
            db,
            logger,
            journeyRegistry,
            bucket,
          });
        }

        // Dwell pass — runs AFTER the TTL pass (ordering is load-bearing: a
        // member force-left by maxDwell earlier this iteration is status='left'
        // here, so the dwell scan's status='active' filter excludes it). Fires
        // `bucket:dwell:<id>:<label>` over the continuously-dwelling active
        // population at cron resolution (Section 6.4–6.6).
        if (hasDwell) {
          reconciled += await reconcileBucketDwell({
            db,
            logger,
            journeyRegistry,
            bucket,
            dwellReactions,
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

    // Durable sleep to the deadline — normalized to whole seconds: a raw ms
    // number renders as a multi-unit duration string some hatchet-lite versions
    // silently no-op (instant wake → premature expiry evaluation).
    await ctx.sleepFor(toSleepDuration(input.msUntilExpiry));

    const bucket = registry.get(input.bucketId);
    if (!bucket?.criteria) {
      return { status: "skipped", reason: "bucket_unregistered" };
    }

    // On wake, re-confirm the criteria still says "should leave". If the user
    // re-qualified (e.g. fired the event again), do not leave. Load merged
    // contact properties iff a property leg needs them so property predicates
    // match the real-time path instead of evaluating against undefined.
    const journeyContext =
      collectPropertyNames(bucket.criteria).length > 0
        ? await loadContactProperties(db, input.userId)
        : {};
    const stillMember = await evaluateCondition({
      condition: bucket.criteria,
      ctx: { db, userId: input.userId, journeyContext },
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
      // Fast-expiry is a criteria re-confirm leave (Section 6.7).
      reason: "criteria",
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
      reason: "criteria",
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

  // Pull contact properties alongside members iff a property leg needs them, so
  // property predicates in a composite evaluate against MERGED contact state —
  // the SAME state the real-time path reads — instead of always-undefined.
  const needsProps = collectPropertyNames(criteria).length > 0;
  const members = await db
    .select({
      userId: bucketMemberships.userId,
      properties: contacts.properties,
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
    const journeyContext = needsProps
      ? ((member.properties as Record<string, unknown> | null) ?? {})
      : {};
    const isMember = await evaluateCondition({
      condition: criteria,
      ctx: { db, userId: member.userId, journeyContext },
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
  return bulkLeave({
    db,
    logger,
    journeyRegistry,
    bucket,
    userIds: leaverIds,
    reason: "criteria",
  });
}

/**
 * Unconditional max-dwell TTL leave (per-bucket `maxDwell`). Selects active
 * members whose `maxDwellAt` deadline has passed (GDPR: live contacts only) and
 * force-leaves them through the shared `bulkLeave` CAS — with NO criteria
 * re-evaluation, unlike the criteria SHOULD-LEAVE path. Emits `bucket:left`;
 * whether the user can re-join afterwards is governed by the bucket's `entryLimit`
 * policy on their next qualifying event (the per-bucket time-box vs flush knob).
 */
async function reconcileBucketTtlLeaves(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;

  const expired = await db
    .select({ userId: bucketMemberships.userId })
    .from(bucketMemberships)
    .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
    .where(
      and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        isNotNull(bucketMemberships.maxDwellAt),
        lte(bucketMemberships.maxDwellAt, new Date()),
        isNull(contacts.deletedAt),
      ),
    );

  if (expired.length === 0) return 0;
  return bulkLeave({
    db,
    logger,
    journeyRegistry,
    bucket,
    userIds: expired.map((r) => r.userId),
    reason: "maxDwell",
  });
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
  /** Why these members leave — TTL passes "maxDwell", criteria passes "criteria". */
  reason: BucketLeaveReason;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket, userIds, reason } = opts;

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
      reason,
    });
  }

  return flipped.length;
}

/**
 * Dwell pass for one bucket (Section 6.4–6.6). Fires `bucket:dwell:<id>:<label>`
 * over the EXISTING continuously-dwelling active population at cron resolution —
 * its unique value over `on("enter") + ctx.sleep`. Idempotent across sweeps,
 * interoperable with maxDwell/fastExpiry, and routed through
 * `emitBucketTransition` (NOT a raw push) for `userEvents`/exitOn/history/analytics
 * parity (Section 6.1):
 *
 *  - PUSH FIRST (at-least-once; the deterministic idempotencyKey + the userEvents
 *    dedup absorb a same-sweep retry), THEN stamp `dwellState` (the inter-sweep
 *    "already fired this membership" gate). The stamp's `status='active'` clause
 *    makes the leave/fastExpiry interop correct (a row flipped to `left` between
 *    SELECT and UPDATE no-ops).
 *  - The dwell clock is `coalesce(dwellAnchorAt, enteredAt)` — backfilled members
 *    use their derived historical anchor (LOCKED DECISION 1), live joins use
 *    enteredAt (anchor NULL).
 *  - Candidates are ordered `lastEvaluatedAt asc nulls first` (oldest-served-first)
 *    so a busy `every` bucket cannot starve members past BATCH_SIZE; the stamp
 *    bumps `lastEvaluatedAt`, advancing the cursor. Hitting BATCH_SIZE is logged
 *    once per sweep (visibility, not silent).
 *  - First-deploy quiet window: reuse `firstTimeBackfillIncomplete` so the
 *    pre-existing/backfilled population is not blasted before the first-time
 *    backfill has settled.
 *
 * `every` is fires-at-most-once-per-sweep, coalescing (one catch-up fire after a
 * multi-interval outage); `dwellCount` is the deterministic interval ordinal
 * `floor((sweepInstant - anchor) / offsetMs)` (gap-stable, NOT a fire count). For
 * `after` the ordinal is always 1 (one-shot).
 */
async function reconcileBucketDwell(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
  dwellReactions: JourneyMeta[];
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket, dwellReactions } = opts;

  // First-deploy quiet window: do not blast the pre-existing/backfilled
  // population before the first-time backfill has settled (reuse the guard).
  if (await firstTimeBackfillIncomplete(db, bucket)) return 0;

  // Captured once per invocation and reused for the ordinal. The ordinal is
  // floor((sweepInstant - anchor) / offsetMs), so it is grid-quantized: a Hatchet
  // retry (a fresh fn() invocation, seconds–minutes later) lands in the SAME
  // interval window and recomputes the SAME ordinal → SAME idempotencyKey →
  // absorbed by the userEvents dedup. `after` is always ordinal 1 (fully stable).
  // Residual edge: an `every` retry that straddles an interval boundary yields a
  // new ordinal and thus one extra dwell fire — bounded to a single duplicate by
  // the key, and only possible for sub-retry-window intervals. Documented, not
  // load-bearing for the common (hours/days) intervals.
  const sweepInstant = Date.now();
  let fired = 0;

  for (const reaction of dwellReactions) {
    const schedule = reaction.dwellSchedule;
    if (!schedule) continue;
    const { label, after, every } = schedule;
    const offsetMs = after ?? every;
    if (offsetMs == null) continue;
    const cutoff = new Date(sweepInstant - offsetMs);

    // Continuous-member gate. coalesce(dwellAnchorAt, enteredAt) is the dwell
    // clock. Oldest-served-first (Section 6.5).
    const candidates = await db
      .select({
        id: bucketMemberships.id,
        userId: bucketMemberships.userId,
        userEmail: bucketMemberships.userEmail,
        entryCount: bucketMemberships.entryCount,
        anchor: sql<Date>`coalesce(${bucketMemberships.dwellAnchorAt}, ${bucketMemberships.enteredAt})`,
        dwellState: bucketMemberships.dwellState,
      })
      .from(bucketMemberships)
      .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
      .where(
        and(
          eq(bucketMemberships.bucketId, bucket.id),
          eq(bucketMemberships.status, "active"),
          isNull(bucketMemberships.deletedAt),
          isNull(contacts.deletedAt),
          // Fold the comparison into the fragment with an explicit cast: a JS
          // Date passed to lte() against a raw sql`coalesce(...)` fragment has no
          // column type to drive param encoding, so the pg driver throws on the
          // Date (and the per-bucket try/catch would silently swallow it → 0
          // dwell fires). Binding the ISO string + ::timestamptz is well-typed.
          sql`coalesce(${bucketMemberships.dwellAnchorAt}, ${bucketMemberships.enteredAt}) <= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(sql`${bucketMemberships.lastEvaluatedAt} asc nulls first`)
      .limit(BATCH_SIZE);

    if (candidates.length >= BATCH_SIZE) {
      logger.warn("Bucket dwell pass bounded to BATCH_SIZE/tick", {
        bucketId: bucket.id,
        label,
        batchSize: BATCH_SIZE,
      });
    }

    for (const m of candidates) {
      const state = (m.dwellState ?? {}) as Record<string, string>;
      const lastFired = state[label] ? Date.parse(state[label]) : null;
      const anchorMs = new Date(m.anchor).getTime();

      if (after != null) {
        // one-shot: already fired for this membership → skip.
        if (lastFired != null) continue;
      } else {
        // every: not yet due since the last fire (or the anchor).
        const since = lastFired ?? anchorMs;
        if (sweepInstant - since < offsetMs) continue;
      }

      // Deterministic per (membership, sweepInstant) so a retry recomputes it.
      const ordinal =
        after != null ? 1 : Math.floor((sweepInstant - anchorMs) / offsetMs);

      // PUSH FIRST (at-least-once; idempotencyKey + userEvents dedup absorb
      // retries), THEN stamp. emitBucketTransition handles the
      // userEvents/exitOn/analytics parity.
      await emitBucketTransition({
        db,
        registry: journeyRegistry,
        hatchet,
        logger,
        kind: "dwell",
        bucket,
        userId: m.userId,
        userEmail: m.userEmail,
        epoch: m.entryCount,
        source: "reconcile",
        dwellLabel: label,
        dwellOrdinal: ordinal,
      });

      // Stamp the membership (inter-sweep gate). status='active' clause = leave
      // interop (a row flipped to 'left' between SELECT and UPDATE no-ops).
      await db
        .update(bucketMemberships)
        .set({
          dwellState: sql`jsonb_set(coalesce(${bucketMemberships.dwellState}, '{}'::jsonb), ${`{${label}}`}, ${`"${new Date(sweepInstant).toISOString()}"`}::jsonb)`,
          lastEvaluatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bucketMemberships.id, m.id),
            eq(bucketMemberships.status, "active"),
          ),
        );
      fired += 1;
    }
  }

  return fired;
}

/**
 * reconcileJoins (absence buckets): materialize NEW members the real-time path
 * cannot see — a user who STOPS doing X fires no event, so only the clock can
 * enroll them. ONE bounded (BATCH_SIZE per tick) path handles every shape, but
 * the per-candidate handling splits on whether the SQL candidate set is EXACT:
 *
 *  - SET-BASED / EXACT (no per-member confirm, Fix #3) — the SAFE shapes the
 *    engine auto-infers `reconcileJoins` on:
 *      (a) SINGLE-EVENT `not_exists within W` — the `present` windowed anti-join
 *          makes the candidate query exact, and
 *      (b) the LAPSED-ACTIVE composite `all(event(X).exists(),
 *          event(X).within(W).not_exists())` — ever-fired X satisfies the exists()
 *          leg and the present-in-X's-window anti-join satisfies the not_exists()
 *          leg, so EVERY returned row is a true matcher.
 *    Because each matcher becomes an active member, the next tick excludes it →
 *    the `externalId asc` page advances naturally and the scan cannot starve.
 *  - PER-MEMBER CONFIRM (non-exact superset) — any OTHER absence-containing
 *    composite (an OR of absence legs, or absence mixed with property/count legs)
 *    reached ONLY via an EXPLICIT `reconcileJoins: true`. The candidate query is a
 *    cheap superset, so each candidate is confirmed with `evaluateCondition`
 *    (correct AND/OR) before it is materialized. This path is BATCH_SIZE-bounded
 *    per tick: a wide non-matching prefix can keep genuine matchers off the page
 *    indefinitely (a clean cursor would require a per-candidate examined-stamp =
 *    a schema change), so the bound is LOGGED once per sweep rather than silently
 *    starving (Fix #3).
 *
 * In all cases the candidate set is the exists-ever floor over ALL windowed
 * `not_exists` legs (the UNION of their ever-fired sets — so an OR of absence
 * legs never silently drops a user who only fired the OTHER leg), MINUS users
 * present in EVERY absence leg's window (always-safe to exclude: such a user
 * fails every not_exists leg, so they qualify via none — this drops the
 * currently-active prefix so the bounded scan reaches genuinely-dormant users
 * and converges), MINUS current active members. Deterministic `externalId asc`
 * pages the cohort across ticks (convergence in ceil(candidates / BATCH_SIZE)).
 *
 * Composite NON-absence and positive shapes are caught real-time on event
 * arrival, so they short-circuit to 0 here.
 */
async function reconcileBucketJoins(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;
  const criteria = bucket.criteria as ConditionEval;

  // First-deploy guard (Fix #2): the JOIN path must NOT emit `bucket:entered`
  // for historically-dormant users while a brand-new bucket's first-time
  // backfill is still claiming them silently. The backfill materializes
  // historical members WITHOUT live emission (the Customer.io rule); if the
  // cron's absence-join scan runs concurrently it would re-discover the SAME
  // dormant cohort and emit for them — a historical blast. So skip the join
  // path entirely until the first-time backfill has persisted its
  // criteriaHash. The transition skipped→active-joins happens when the backfill
  // task finishes and calls persistCriteriaHash (bucket-backfill.ts), at which
  // point bucket_configs.criteriaHash is non-null and no first-time job is in
  // flight. (The LEAVE + maxDwell TTL paths are unaffected — see the caller.)
  if (await firstTimeBackfillIncomplete(db, bucket)) {
    logger.info("Bucket join reconcile skipped (first-time backfill pending)", {
      bucketId: bucket.id,
    });
    return 0;
  }

  // Every windowed not_exists leg (the shapes a clock can JOIN). No absence leg
  // → nothing for the cron to materialize (positive shapes are caught live).
  const absenceLegs = collectAbsenceLegs(criteria);
  if (absenceLegs.length === 0) return 0;

  // Exists-ever floor: contacts who fired ANY absence-leg event AT LEAST ONCE
  // (no window). UNIONing across legs keeps an OR-of-absence bucket from
  // dropping a user who only ever fired one of the legs. Excludes brand-new
  // never-active signups and bounds the scan to the once-active cohort.
  const everFiredEvents = Array.from(new Set(absenceLegs.map((l) => l.event)));
  const everFired = db
    .selectDistinct({ userId: userEvents.userId })
    .from(userEvents)
    .where(inArray(userEvents.event, everFiredEvents))
    .as("ever_fired");

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

  // Present-in-ALL-windows exclusion: a user who fired EVERY absence-leg event
  // inside that leg's window fails every not_exists leg, so they cannot qualify
  // (AND or OR). Dropping them is always-safe AND breaks the prefix-lock — the
  // currently-active cohort (which fails the criteria anyway) is excluded so the
  // bounded scan reaches real dormant users. For a single absence leg this is
  // exactly the single-event `present` anti-join; the SQL is then exact.
  //
  // The exclusion is only applied when every leg has a DISTINCT event, so the
  // `count(distinct event) = #legs` test exactly means "present in each leg's
  // window". Two legs on the SAME event with different windows would let the
  // wider window over-exclude a user who is absent in the tighter (joinable)
  // window, so that pathological shape skips the exclusion and relies on the
  // per-member confirm + paging (no over-exclusion, just no early prune).
  const distinctLegEvents = new Set(absenceLegs.map((l) => l.event));
  const canExclude = distinctLegEvents.size === absenceLegs.length;
  const presentInAll = canExclude
    ? selectPresentInAllWindows(db, absenceLegs)
    : null;

  // The membership/event tables key on the RESOLVED string key (external_id ??
  // anonymous_id ?? contact.id), NOT necessarily external_id — email-only /
  // anonymous contacts have a NULL external_id and are keyed on their uuid /
  // anonymous_id. Joining on contacts.externalId would force external_id NOT NULL
  // for every candidate (the coalesce would collapse to external_id) and silently
  // drop exactly the dormant email-only contacts this cron exists to reconcile.
  // Join on the SAME coalesce expression so the projected key matches the join.
  const contactKey = contactKeySql();

  const baseQuery = db
    .select({
      userId: contactKey,
      email: contacts.email,
    })
    .from(contacts)
    .innerJoin(everFired, eq(everFired.userId, contactKey))
    .leftJoin(activeMembers, eq(activeMembers.userId, contactKey));

  const candidates = await (presentInAll
    ? baseQuery
        .leftJoin(presentInAll, eq(presentInAll.userId, contactKey))
        .where(
          and(
            isNull(contacts.deletedAt),
            isNull(activeMembers.userId),
            isNull(presentInAll.userId),
          ),
        )
    : baseQuery.where(
        and(isNull(contacts.deletedAt), isNull(activeMembers.userId)),
      )
  )
    // Deterministic scan order for the bounded re-run (no keyset cursor; the
    // scan advances as reconciled matchers become active members and drop out).
    // Order by contacts.id (the non-null unique PK) so the scan is null-safe and
    // stable even for null-external_id contacts now that the join is on the
    // coalesce key.
    .orderBy(sql`${contacts.id} asc`)
    .limit(BATCH_SIZE);

  // SET-BASED / EXACT shapes (Fix #3) — every candidate row is a true matcher,
  // so the per-member confirm is skipped entirely:
  //   (a) a single absence leg makes the candidate query exact (present-in-all =
  //       the one leg's present anti-join), and
  //   (b) the lapsed-active composite — ever-fired X satisfies the exists() leg
  //       and the present-in-X-window exclusion satisfies the not_exists() leg.
  // Any OTHER composite (OR-of-absence, absence + property/count) is a non-exact
  // superset that needs the full `evaluateCondition` confirm for correct AND/OR.
  const exact =
    (criteria.type === "event" && absenceLegs.length === 1) ||
    isLapsedActiveComposite(criteria) != null;

  // Merged contact properties feed property legs in the per-member confirm so
  // an absence+property composite evaluates the SAME way it does on the
  // real-time path (which reads merged contact state). Empty when no confirm
  // runs (exact path) or no property leg exists.
  const needsProps = !exact && collectPropertyNames(criteria).length > 0;

  // The non-exact per-member path is BATCH_SIZE-bounded per tick with no
  // examined-cursor (a clean cursor would need a schema change). Log the bound
  // ONCE per sweep so a wide non-matching prefix that delays genuine matchers is
  // visible rather than a silent starve (Fix #3).
  if (!exact && candidates.length >= BATCH_SIZE) {
    logger.warn(
      "Bucket composite-join confirm is bounded to BATCH_SIZE/tick (explicit reconcileJoins); matchers behind a wide non-matching prefix may take multiple ticks to enroll",
      { bucketId: bucket.id, batchSize: BATCH_SIZE },
    );
  }

  let joined = 0;
  for (const candidate of candidates) {
    if (!exact) {
      const journeyContext = needsProps
        ? await loadContactProperties(db, candidate.userId)
        : {};
      const isMember = await evaluateCondition({
        condition: criteria,
        ctx: { db, userId: candidate.userId, journeyContext },
      });
      if (!isMember) continue;
    }

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
 * True while a bucket's first-time backfill has NOT completed — the gate that
 * keeps the cron JOIN path from emitting a historical blast on first deploy
 * (Fix #2). Two signals, either of which means "not yet safe to join-reconcile":
 *
 *   1. `bucket_configs.criteriaHash IS NULL` (or no row at all) — the first-time
 *      backfill task persists this hash on completion (persistCriteriaHash in
 *      bucket-backfill.ts), so a null/absent hash means the backfill has not yet
 *      finished claiming the historical cohort silently.
 *   2. A first-time backfill `import_jobs` row is in flight — `fileName =
 *      bucket.id AND format = FIRST_TIME_FORMAT AND status IN
 *      ('pending','processing')`. This covers the boot window AFTER a prior run
 *      persisted a hash but BEFORE a freshly-enqueued first-time job runs (and
 *      the general in-flight case), so a concurrent cron tick never races the
 *      backfill's silent materialization.
 *
 * The transition skipped→active-joins is monotonic: once the backfill completes,
 * the hash is non-null AND its job leaves the in-flight set, so the next cron
 * tick proceeds with the absence-join scan as normal.
 */
async function firstTimeBackfillIncomplete(
  db: Database,
  bucket: BucketMeta,
): Promise<boolean> {
  // (1) criteriaHash not yet persisted → backfill hasn't finished.
  const config = await db.query.bucketConfigs.findFirst({
    where: eq(bucketConfigs.bucketId, bucket.id),
  });
  if (!config || config.criteriaHash == null) return true;

  // (2) a first-time backfill job is still pending/processing for this bucket.
  const inFlight = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        eq(importJobs.fileName, bucket.id),
        eq(importJobs.format, FIRST_TIME_FORMAT),
        inArray(importJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return inFlight.length > 0;
}

/**
 * A subquery of users who fired EVERY absence leg's event inside that leg's
 * rolling window — the intersection across legs. Such a user fails every
 * not_exists leg, so they qualify via none and are always-safe to exclude from
 * candidates. PRECONDITION: every leg has a DISTINCT event (the caller enforces
 * this), so `count(distinct event) = #legs` exactly means "present in each leg's
 * window".
 */
function selectPresentInAllWindows(db: Database, legs: AbsenceLeg[]) {
  // OR together each leg's "fired this event inside its window" predicate, then
  // require a distinct match for EVERY leg (count(distinct event) = #legs).
  const perLeg = legs.map((leg) =>
    and(
      eq(userEvents.event, leg.event),
      leg.cutoff ? gte(userEvents.occurredAt, leg.cutoff) : undefined,
    ),
  );
  return db
    .select({ userId: userEvents.userId })
    .from(userEvents)
    .where(or(...perLeg))
    .groupBy(userEvents.userId)
    .having(sql`count(distinct ${userEvents.event}) >= ${legs.length}`)
    .as("present_all");
}

/** The merged stored properties of a contact (for property-leg evaluation). */
async function loadContactProperties(
  db: Database,
  userId: string,
): Promise<Record<string, unknown>> {
  const [contact] = await db
    .select({ properties: contacts.properties })
    .from(contacts)
    .where(eq(contacts.externalId, userId))
    .limit(1);
  return (contact?.properties as Record<string, unknown> | null) ?? {};
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
  const { db, logger, journeyRegistry, bucket, userId } = opts;
  // Normalized at the write site (audience-model.md wart #1) — the contact row
  // should already be normalized, but the membership keyspace must never
  // depend on that.
  const userEmail = normalizeEmailOrNull(opts.userEmail);

  // entryCount ordinal = 1 + ALL prior memberships (active + left). Shared with
  // the real-time join path so the ordinal never drifts between the two writers.
  const priorCount = await countPriorMemberships(db, bucket.id, userId);
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
      expiresAt: computeExpiresAt(bucket),
      maxDwellAt: computeMaxDwellAt(bucket),
      lastEvaluatedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: bucketMemberships.id });

  if (inserted.length !== 1) {
    return false;
  }

  // The active row is always written (Studio size must reflect reality) and the
  // epoch always advances via the real insert; only the bucket:entered emission
  // is gated by the entryLimit policy — mirrors the real-time join path so the
  // cron-discovered join cannot bypass entryLimit (Section 6.3).
  if (await shouldEmitJoin({ db, bucket, userId, priorCount })) {
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
  } else {
    logger.info("Bucket join emit suppressed by entryLimit policy", {
      bucketId: bucket.id,
      userId,
      entryLimit: bucket.entryLimit ?? "unlimited",
    });
  }

  return true;
}

/** A bucket is time-based if flagged OR its criteria carry a `within` window. */
function isTimeBased(bucket: BucketMeta): boolean {
  if (bucket.timeBased) return true;
  if (!bucket.criteria) return false;
  return firstWithin(bucket.criteria) != null;
}

/**
 * Resolve the JOIN-reconciliation decision for a bucket (tri-state on
 * `reconcileJoins`):
 *  - `false` → hard OFF (explicit cost-bounding override; the absence join is
 *    skipped even for an absence-shaped bucket).
 *  - `true`  → explicit ON (unchanged 0.2.0 opt-in behavior).
 *  - `undefined` → INFERRED, but ONLY for the two SAFE set-based shapes the cron
 *    can JOIN with an EXACT SQL candidate set (every returned row a true matcher,
 *    so no per-member confirm → no starvation, Fix #3):
 *      (a) a single-event windowed `not_exists` criterion, and
 *      (b) the lapsed-active composite `all(event(X).exists(),
 *          event(X).within(W).not_exists())` (see {@link isLapsedActiveComposite}).
 *    ANY OTHER absence-containing composite (an OR of absence legs, or absence
 *    mixed with extra property/count legs) is NOT auto-inferred — its candidate
 *    set is a non-exact superset that needs a per-member confirm, which is
 *    BATCH_SIZE-bounded per tick and can starve, so it requires an explicit
 *    `reconcileJoins: true` opt-in. Non-absence time-based buckets still skip the
 *    join scan (their joins are caught real-time).
 */
function shouldReconcileJoins(bucket: BucketMeta): boolean {
  if (bucket.reconcileJoins === false) return false;
  if (bucket.reconcileJoins === true) return true;
  if (!bucket.criteria) return false;
  return isSafeAbsenceShape(bucket.criteria);
}

/**
 * The two SAFE absence shapes whose cron-JOIN candidate set is EXACT in SQL
 * alone — the only shapes the engine AUTO-INFERS `reconcileJoins` on (Fix #3):
 *   (a) a single-event windowed `not_exists` criterion, and
 *   (b) the lapsed-active composite (see {@link isLapsedActiveComposite}).
 * Every other absence-containing composite is a non-exact superset and must opt
 * in explicitly (the per-member confirm path is BATCH_SIZE-bounded per tick).
 */
function isSafeAbsenceShape(criteria: ConditionEval): boolean {
  if (
    criteria.type === "event" &&
    criteria.check === "not_exists" &&
    criteria.within != null
  ) {
    return true;
  }
  return isLapsedActiveComposite(criteria) != null;
}

/** The recognized lapsed-active composite (shape (b)): event + window cutoff. */
interface LapsedActiveShape {
  event: string;
  /** now - within for the not_exists leg's window. */
  cutoff: Date;
}

/**
 * Recognize shape (b) — the flagship "went-dormant" composite — and return its
 * (event, window cutoff), else null. It is a composite AND of EXACTLY two legs on
 * the SAME event X: an `event(X).exists()` ever-fired anchor (no window) and an
 * `event(X).within(W).not_exists()` windowed-absence leg. Because the candidate
 * SQL (ever-fired X, MINUS present-in-X's-window, MINUS active members) satisfies
 * BOTH legs of the AND for every returned row, the set is EXACT — no per-member
 * `evaluateCondition` is needed and the page advances naturally (matchers become
 * active members → excluded next tick), so it cannot starve (Fix #3).
 */
function isLapsedActiveComposite(
  criteria: ConditionEval,
): LapsedActiveShape | null {
  if (
    criteria.type !== "composite" ||
    criteria.operator !== "and" ||
    criteria.conditions.length !== 2
  ) {
    return null;
  }

  const existsLeg = criteria.conditions.find(
    (c) => c.type === "event" && c.check === "exists" && c.within == null,
  );
  const notExistsLeg = criteria.conditions.find(
    (c) => c.type === "event" && c.check === "not_exists" && c.within != null,
  );
  if (
    existsLeg?.type !== "event" ||
    notExistsLeg?.type !== "event" ||
    existsLeg.eventName !== notExistsLeg.eventName ||
    notExistsLeg.within == null
  ) {
    return null;
  }

  return {
    event: notExistsLeg.eventName,
    cutoff: new Date(Date.now() - durationToMs(notExistsLeg.within)),
  };
}

/** One windowed `not_exists` leg: the event + its window cutoff instant. */
interface AbsenceLeg {
  event: string;
  /** now - within for the leg's window; null only if within is somehow unset. */
  cutoff: Date | null;
}

/**
 * Every windowed `not_exists` leg in a criteria tree (depth-first) — "stopped
 * doing X in the last N", the only shapes a clock can materialize a JOIN for. An
 * UNBOUNDED not_exists (no window) is degenerate and not auto-joinable (the
 * schema already rejects pure-unbounded-negation buckets), so it is skipped.
 * Collecting ALL legs (not just the first) keeps an OR-of-absence composite from
 * silently dropping users who only ever fired one of the legs.
 */
function collectAbsenceLegs(criteria: ConditionEval): AbsenceLeg[] {
  if (criteria.type === "event") {
    if (criteria.check === "not_exists" && criteria.within != null) {
      return [
        {
          event: criteria.eventName,
          cutoff: new Date(Date.now() - durationToMs(criteria.within)),
        },
      ];
    }
    return [];
  }
  if (criteria.type === "composite") {
    return criteria.conditions.flatMap(collectAbsenceLegs);
  }
  return [];
}
