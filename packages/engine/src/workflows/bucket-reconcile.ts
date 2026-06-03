import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BucketMeta,
  type ConditionEval,
  collectPropertyNames,
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
import { countPriorMemberships } from "../buckets/membership-epoch.js";
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

      // Process a bucket here iff a clock can flip its membership: a TIME-BASED
      // criteria window (criteria-driven leaves/joins) OR an unconditional
      // `maxDwell` TTL (membership-age-driven leaves). timeBased is honoured
      // explicitly OR inferred from a `within` window.
      const timeBased = isTimeBased(bucket);
      if (!timeBased && !bucket.maxDwell) continue;

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
          // true for absence-shaped buckets only (a windowed `not_exists` leg —
          // the sole shape a clock can JOIN), keeping the sweep O(active
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
  return bulkLeave({ db, logger, journeyRegistry, bucket, userIds: leaverIds });
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
 * cannot see — a user who STOPS doing X fires no event, so only the clock can
 * enroll them. ONE bounded (BATCH_SIZE per tick) path handles both shapes:
 *
 *  - SINGLE-EVENT `not_exists within W` — the candidate query IS exact (the
 *    `present` windowed anti-join makes it so), so no per-member confirm runs.
 *  - COMPOSITE absence (e.g. the lapsed-active shape `all(event(X).exists(),
 *    event(X).within(N).notExists())`, or an OR of several absence legs) — the
 *    candidate query is a cheap superset, so each candidate is confirmed with
 *    `evaluateCondition` (correct AND/OR) before it is materialized.
 *
 * In both cases the candidate set is the exists-ever floor over ALL windowed
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

  const baseQuery = db
    .select({
      userId: contacts.externalId,
      email: contacts.email,
    })
    .from(contacts)
    .innerJoin(everFired, eq(everFired.userId, contacts.externalId))
    .leftJoin(activeMembers, eq(activeMembers.userId, contacts.externalId));

  const candidates = await (presentInAll
    ? baseQuery
        .leftJoin(presentInAll, eq(presentInAll.userId, contacts.externalId))
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
    .orderBy(sql`${contacts.externalId} asc`)
    .limit(BATCH_SIZE);

  // A single absence leg makes the candidate query exact (present-in-all = the
  // one leg's present anti-join), so the per-member confirm is redundant. A
  // composite with multiple legs (or any non-event top-level criteria, i.e. an
  // AND/OR with extra non-absence legs) needs the full `evaluateCondition`
  // confirm for correct AND/OR before materializing a member.
  const exact = criteria.type === "event" && absenceLegs.length === 1;

  // Merged contact properties feed property legs in the per-member confirm so
  // an absence+property composite evaluates the SAME way it does on the
  // real-time path (which reads merged contact state). Empty when no confirm
  // runs (single-event exact path) or no property leg exists.
  const needsProps = !exact && collectPropertyNames(criteria).length > 0;

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
  const { db, logger, journeyRegistry, bucket, userId, userEmail } = opts;

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
      expiresAt: computeReconcileExpiresAt(bucket),
      maxDwellAt: bucket.maxDwell
        ? new Date(Date.now() + durationToMs(bucket.maxDwell))
        : null,
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

/**
 * Resolve the JOIN-reconciliation decision for a bucket (tri-state on
 * `reconcileJoins`):
 *  - `false` → hard OFF (explicit cost-bounding override; the absence join is
 *    skipped even for an absence-shaped bucket).
 *  - `true`  → explicit ON (unchanged 0.2.0 opt-in behavior).
 *  - `undefined` → INFERRED: ON iff the criteria are absence-shaped (a windowed
 *    `not_exists` leg — the only shape a clock can JOIN). Non-absence time-based
 *    buckets still skip the join scan (their joins are caught real-time).
 */
function shouldReconcileJoins(bucket: BucketMeta): boolean {
  if (bucket.reconcileJoins === false) return false;
  if (bucket.reconcileJoins === true) return true;
  if (!bucket.criteria) return false;
  return isAbsenceShaped(bucket.criteria);
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

/**
 * A criteria tree is "absence-shaped" iff it contains at least one windowed
 * `not_exists` leg — the only shape a clock can materialize a JOIN for. Defined
 * in terms of {@link collectAbsenceLegs} so the absence predicate has a single
 * source of truth (no two walkers to drift).
 */
function isAbsenceShaped(criteria: ConditionEval): boolean {
  return collectAbsenceLegs(criteria).length > 0;
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
