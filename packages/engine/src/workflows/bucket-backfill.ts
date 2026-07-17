import { createHash } from "node:crypto";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BucketMeta,
  type ConditionEval,
  durationToMs,
  evaluateCondition,
} from "@hogsend/core";
import {
  bucketConfigs,
  bucketMemberships,
  contacts,
  createDatabase,
  type Database,
  importJobs,
  userEvents,
} from "@hogsend/db";
import { and, eq, gt, gte, inArray, isNull, max, sql } from "drizzle-orm";
import {
  computeExpiresAt,
  computeMaxDwellAt,
  matchesEventCount,
} from "../buckets/membership-epoch.js";
import { getBucketRegistrySingleton } from "../buckets/registry-singleton.js";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import { contactKeySql, normalizeEmailOrNull } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";
import { stableStringify } from "../lib/stable-stringify.js";

/** Insert chunk size, reusing the import-contacts precedent (Section 6.6). */
const BATCH_SIZE = 500;

/** import_jobs.format discriminator for the reused status record (Section 6.6). */
export const FIRST_TIME_FORMAT = "bucket-backfill";
const REEVAL_FORMAT = "bucket-reeval";

/**
 * A stable fingerprint of a bucket's criteria (Section 6.6 B). Normalizes the
 * `ConditionEval` tree (sorted object keys so key order does not change the hash),
 * then sha256-hex. Persisted on `bucket_configs.criteriaHash` and diffed on the
 * next boot to detect a criteria change and enqueue re-evaluation.
 */
export function computeCriteriaHash(
  criteria: ConditionEval | undefined,
): string {
  return createHash("sha256")
    .update(stableStringify(criteria ?? null))
    .digest("hex");
}

/**
 * Engine-owned backfill / criteria-change re-evaluation task (Section 6.6). Runs in
 * two modes:
 *
 *   - mode:"first-time" — a NEW bucket id appeared. Materialize the full member set
 *     via a SET-BASED query per criteria shape, insert `active` rows
 *     (`source:"backfill"`, onConflictDoNothing on the partial-active unique
 *     index), and SUPPRESS live join emission (historical matches must not fire
 *     `bucket:entered` into live journeys — the Customer.io rule).
 *   - mode:"reeval" — an EXISTING bucket's criteria changed (detected via
 *     `criteriaHash` diff at boot). A FULL diff: INSERT active rows for new
 *     matchers (joins, NO emit) AND transition active members who no longer match
 *     → `left` via CAS (leaves EMIT `bucket:left` so in-flight journeys exit).
 *
 * Progress is tracked in `import_jobs` (the precedent), discriminated by `format`
 * (`bucket-backfill` / `bucket-reeval`) with `fileName` carrying the bucketId, so
 * the Studio "building / live" badge derives from a real status record (Section
 * 11.3). Set-based, chunked, idempotent, resumable — never run in a migration.
 */
export interface BucketBackfillInput extends JsonObject {
  jobId: string;
  bucketId: string;
  mode: "first-time" | "reeval";
}

export const bucketBackfillTask = hatchet.task({
  name: "bucket-backfill",
  retries: 0,
  executionTimeout: "600s",
  fn: async (input: BucketBackfillInput) => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const registry = getBucketRegistrySingleton();
    const journeyRegistry = getJourneyRegistrySingleton();

    const bucket = registry.get(input.bucketId);
    if (!bucket || bucket.kind === "manual" || !bucket.criteria) {
      await db
        .update(importJobs)
        .set({
          status: "failed",
          errors: [{ row: 0, error: "bucket_unregistered_or_manual" }],
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.jobId));
      return { status: "failed", reason: "bucket_unregistered_or_manual" };
    }

    await db
      .update(importJobs)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(importJobs.id, input.jobId));

    try {
      // (A/B) JOINS — new matchers materialized as active rows (NO emit, both
      // modes suppress join emission, Section 6.6).
      const joined = await backfillJoins({
        db,
        logger,
        bucket,
        jobId: input.jobId,
      });

      // (B only) LEAVES — active members who no longer match are transitioned to
      // left via CAS and EMIT bucket:left (so in-flight journeys exit).
      let leftCount = 0;
      if (input.mode === "reeval") {
        leftCount = await reevalLeaves({
          db,
          logger,
          journeyRegistry,
          bucket,
        });
      }

      // Persist the current criteria hash so the next boot diff is a no-op until
      // the criteria actually change again (Section 6.6 B).
      await persistCriteriaHash(db, bucket);

      await db
        .update(importJobs)
        .set({
          status: "completed",
          processedRows: joined + leftCount,
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.jobId));

      logger.info("Bucket backfill complete", {
        bucketId: bucket.id,
        mode: input.mode,
        joined,
        left: leftCount,
      });
      return { status: "completed", joined, left: leftCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(importJobs)
        .set({
          status: "failed",
          errors: [{ row: 0, error: message }],
          updatedAt: new Date(),
        })
        .where(eq(importJobs.id, input.jobId));
      logger.error("Bucket backfill failed", { bucketId: bucket.id, message });
      return { status: "failed", reason: message };
    }
  },
});

/**
 * Materialize members for the bucket via a SET-BASED query per criteria shape,
 * inserting `active` rows in BATCH_SIZE chunks (`source:"backfill"`,
 * onConflictDoNothing so existing active rows are untouched and re-runs are
 * idempotent). NO live join emission (Section 6.6). Returns the count of NEW rows.
 *
 * Single-event / count criteria use a set-based SQL query; composite criteria fall
 * back to a chunked per-contact `evaluateCondition` loop (the documented O(P)
 * exception).
 */
async function backfillJoins(opts: {
  db: Database;
  logger: Logger;
  bucket: BucketMeta;
  jobId: string;
}): Promise<number> {
  const { db, bucket, jobId } = opts;
  const criteria = bucket.criteria as ConditionEval;

  const matcherIds =
    criteria.type === "event"
      ? await selectEventMatchers(db, criteria)
      : await selectCompositeMatchers(db, criteria);

  await db
    .update(importJobs)
    .set({ totalRows: matcherIds.length, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));

  // Unconditional max-dwell TTL deadline, stamped once at insert (mirrors the
  // live join, check-membership.ts). null when the bucket has no maxDwell; the
  // TTL sweep (reconcileBucketTtlLeaves) filters isNotNull(maxDwellAt), so an
  // unset value would never be force-left.
  const maxDwellAt = computeMaxDwellAt(bucket);

  // Historical dwell anchor (Section 6.3 / LOCKED DECISION 1). For a
  // windowed/event criterion the anchor is `max(occurredAt)` of the qualifying
  // event = "when they became dormant" (e.g. went-dormant = the last
  // `app_opened`). The dwell gate reads `coalesce(dwellAnchorAt, enteredAt)`, so
  // backfilled members start the dwell clock at their real historical instant
  // rather than the deploy-time `enteredAt`. Shapes with no cheap per-matcher
  // timestamp leave the anchor NULL (fall back to enteredAt). The live join path
  // (handleJoin) never sets dwellAnchorAt, so post-deploy joins clock from their
  // real enteredAt. Computed batched per chunk (one GROUP BY max(occurredAt),
  // mirroring the priorCounts GROUP BY) — never per-user serial queries.
  const anchorEvent = resolveDwellAnchorEvent(criteria);

  // Fix C (DEFERRED): backfilled fastExpiry rows are NOT armed with a
  // bucket:arm-expiry durable timer here — they are picked up by the next cron
  // sweep instead (reconcileBucketLeaves / reconcileBucketTtlLeaves are the
  // authoritative backstop). Conscious choice (cron cadence, default 5m), not an
  // omission: arming at backfill would fan out one durable task per inserted row.

  let inserted = 0;
  for (let i = 0; i < matcherIds.length; i += BATCH_SIZE) {
    const chunk = matcherIds.slice(i, i + BATCH_SIZE);

    // userEmail backfilled from the contacts row where available. The chunk
    // holds the RESOLVED key (coalesce(external_id, anonymous_id, id)) — for an
    // email-only / anonymous contact that is the anonymous_id or the uuid id, NOT
    // the (null) external_id. Looking up by `contacts.externalId` would miss
    // those rows and write a NULL userEmail despite the contact having an email,
    // so we key the lookup + the map by the SAME coalesce expression the chunk
    // carries (matches reconcileBucketJoins, which reads userId + email off one
    // contacts row).
    const resolvedKey = contactKeySql();
    const chunkContacts = await db
      .select({ userKey: resolvedKey, email: contacts.email })
      .from(contacts)
      .where(and(inArray(resolvedKey, chunk), isNull(contacts.deletedAt)));
    const emailByUser = new Map(chunkContacts.map((c) => [c.userKey, c.email]));

    // Fix A: entryCount = 1 + prior memberships for each (user, bucket), the
    // same monotonic ordinal the live join computes (check-membership.ts). On a
    // FIRST-TIME backfill priorCount is 0 → entryCount 1 (unchanged); on a
    // REEVAL re-join of a user with historical "left" rows it advances the
    // epoch correctly. ONE batched GROUP BY per chunk (never per-user — the set-
    // based path must not reintroduce the O(P) serial-query trap).
    const priorCounts = await db
      .select({
        userId: bucketMemberships.userId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(bucketMemberships)
      .where(
        and(
          eq(bucketMemberships.bucketId, bucket.id),
          inArray(bucketMemberships.userId, chunk),
        ),
      )
      .groupBy(bucketMemberships.userId);
    const priorByUser = new Map(
      priorCounts.map((r) => [r.userId, Number(r.cnt)]),
    );

    // Batched dwell-anchor derivation (LOCKED DECISION 1): one GROUP BY
    // max(occurredAt) over the qualifying event for THIS chunk, mirroring the
    // priorCounts GROUP BY above (never per-user serial queries). Only computed
    // when the criteria shape exposes a cheap per-matcher anchor event; an empty
    // map leaves dwellAnchorAt NULL → the dwell gate falls back to enteredAt.
    let anchorByUser = new Map<string, Date>();
    if (anchorEvent != null) {
      const anchors = await db
        .select({
          userId: userEvents.userId,
          lastAt: max(userEvents.occurredAt),
        })
        .from(userEvents)
        .where(
          and(
            eq(userEvents.event, anchorEvent),
            inArray(userEvents.userId, chunk),
          ),
        )
        .groupBy(userEvents.userId);
      anchorByUser = new Map(
        anchors
          .filter(
            (r): r is { userId: string; lastAt: Date } => r.lastAt != null,
          )
          .map((r) => [r.userId, r.lastAt]),
      );
    }

    const rows = chunk.map((userId) => ({
      userId,
      // Normalized at the write site (audience-model.md wart #1) — belt and
      // braces on top of the contacts row already being normalized.
      userEmail: normalizeEmailOrNull(emailByUser.get(userId)),
      bucketId: bucket.id,
      status: "active" as const,
      source: "backfill" as const,
      entryCount: 1 + (priorByUser.get(userId) ?? 0),
      expiresAt: computeExpiresAt(bucket),
      maxDwellAt,
      // Historical dwell anchor where derivable; NULL otherwise (→ enteredAt).
      dwellAnchorAt: anchorByUser.get(userId) ?? null,
      lastEvaluatedAt: new Date(),
    }));

    const result = await db
      .insert(bucketMemberships)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: bucketMemberships.id });

    inserted += result.length;

    await db
      .update(importJobs)
      .set({ processedRows: inserted, updatedAt: new Date() })
      .where(eq(importJobs.id, jobId));
  }

  return inserted;
}

/**
 * Re-eval LEAVES (mode:"reeval" only) — active members of the bucket who no longer
 * satisfy the (changed) criteria are transitioned to `left` via CAS and EMIT
 * `bucket:left` (Section 6.6 B asymmetry: criteria-change LEAVES emit). Set-based
 * for single-event criteria; chunked per-member otherwise.
 */
async function reevalLeaves(opts: {
  db: Database;
  logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta;
}): Promise<number> {
  const { db, logger, journeyRegistry, bucket } = opts;
  const criteria = bucket.criteria as ConditionEval;

  // The set of users who STILL match (so non-matching active members = leavers).
  const matcherIds =
    criteria.type === "event"
      ? await selectEventMatchers(db, criteria)
      : await selectCompositeMatchers(db, criteria);
  const matcherSet = new Set(matcherIds);

  const activeMembers = await db
    .select({
      id: bucketMemberships.id,
      userId: bucketMemberships.userId,
      userEmail: bucketMemberships.userEmail,
      entryCount: bucketMemberships.entryCount,
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
    );

  const leavers = activeMembers.filter((m) => !matcherSet.has(m.userId));
  if (leavers.length === 0) return 0;

  let leftCount = 0;
  for (let i = 0; i < leavers.length; i += BATCH_SIZE) {
    const chunk = leavers.slice(i, i + BATCH_SIZE);
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
          inArray(
            bucketMemberships.id,
            chunk.map((m) => m.id),
          ),
        ),
      )
      .returning({
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
        source: "backfill",
        reason: "criteria",
      });
    }
    leftCount += flipped.length;
  }

  return leftCount;
}

/** Set-based matcher user-ids for a single-event criterion (Section 6.6). */
async function selectEventMatchers(
  db: Database,
  criteria: Extract<ConditionEval, { type: "event" }>,
): Promise<string[]> {
  const cutoff = criteria.within
    ? new Date(Date.now() - durationToMs(criteria.within))
    : null;

  // count gte N / exists → SELECT user_id ... GROUP BY HAVING. not_exists
  // (absence) → live contacts who EVER fired the event but have NONE in the
  // window (lapsed-only). A bare windowed `not_exists within W` is treated as
  // LAPSED-ONLY (never-active EXCLUDED) in BOTH this backfill and the cron
  // (bucket-reconcile.ts reconcileBucketJoins, the everFired floor), so the two
  // writers agree: brand-new never-active signups are NOT materialized for an
  // absence-within-window bucket — only users who once did X and then stopped.
  if (criteria.check === "not_exists") {
    // everFired floor: contacts who fired the event AT LEAST ONCE (no window),
    // mirroring the cron's `ever_fired` semi-join. Excludes never-active
    // contacts so the two writers select the same lapsed-only cohort.
    const everFired = db
      .selectDistinct({ userId: userEvents.userId })
      .from(userEvents)
      .where(eq(userEvents.event, criteria.eventName))
      .as("ever_fired");

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

    const rows = await db
      .select({
        userId: contactKeySql(),
      })
      .from(contacts)
      .innerJoin(everFired, eq(everFired.userId, contacts.externalId))
      .leftJoin(present, eq(present.userId, contacts.externalId))
      .where(and(isNull(contacts.deletedAt), isNull(present.userId)));
    return rows.map((r) => r.userId);
  }

  // exists / count: group counts then filter by the operator. Fix B: innerJoin
  // live contacts (GDPR — only materialize memberships for non-deleted contacts
  // that actually exist), mirroring selectEventLeavers in bucket-reconcile.ts.
  // The not_exists branch above already filters contacts.deletedAt; without this
  // join the positive-event path could materialize active rows for soft-deleted
  // or orphan-event userIds, diverging from the live/reconcile paths.
  const rows = await db
    .select({
      userId: userEvents.userId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(userEvents)
    .innerJoin(contacts, eq(contacts.externalId, userEvents.userId))
    .where(
      and(
        eq(userEvents.event, criteria.eventName),
        isNull(contacts.deletedAt),
        cutoff ? gte(userEvents.occurredAt, cutoff) : undefined,
      ),
    )
    .groupBy(userEvents.userId);

  return rows
    .filter((r) => matchesEventCount(criteria, Number(r.cnt)))
    .map((r) => r.userId);
}

/**
 * Composite/multi-condition fallback (the documented O(P) exception, Section 6.6):
 * a per-contact `evaluateCondition` loop over live contacts. Property
 * sub-conditions evaluate against the contact's merged properties.
 *
 * KEYSET PAGINATION by `contacts.id` in BATCH_SIZE pages: each page selects
 * `WHERE id > :cursor ORDER BY id ASC LIMIT BATCH_SIZE`, evaluates the criteria
 * per contact, then advances the cursor to the last `id` of the page — repeating
 * until a short page ends the scan. The whole contacts table is never held in
 * memory at once. Paging on `id` (the non-null unique PK) — NOT `external_id`,
 * which is nullable (email-only / anonymous contacts) and would drop every
 * null-external_id row and order NULLs unstably. (reconcileBucketJoins is not a
 * keyset scan — it relies on matchers dropping out as they become active
 * members — so this no longer mirrors it.)
 */
async function selectCompositeMatchers(
  db: Database,
  criteria: ConditionEval,
): Promise<string[]> {
  const matchers: string[] = [];
  let cursor: string | null = null;

  for (;;) {
    const page = await db
      .select({
        id: contacts.id,
        userId: contactKeySql(),
        properties: contacts.properties,
      })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          cursor != null ? gt(contacts.id, cursor) : undefined,
        ),
      )
      .orderBy(sql`${contacts.id} asc`)
      .limit(BATCH_SIZE);

    for (const contact of page) {
      const isMember = await evaluateCondition({
        condition: criteria,
        ctx: {
          db,
          userId: contact.userId,
          journeyContext:
            (contact.properties as Record<string, unknown> | null) ?? {},
        },
      });
      if (isMember) matchers.push(contact.userId);
    }

    // A short page (fewer than a full batch) means the scan is exhausted.
    if (page.length < BATCH_SIZE) break;
    cursor = page[page.length - 1]?.id ?? null;
    if (cursor == null) break;
  }

  return matchers;
}

/**
 * Resolve the event whose `max(occurredAt)` is the historical dwell anchor for a
 * backfilled member (LOCKED DECISION 1 / Section 6.3) — "when they became
 * dormant". Returns an event name only for the windowed/event shapes that expose
 * a cheap per-matcher timestamp; `null` for everything else (the anchor stays
 * NULL and the dwell gate falls back to `enteredAt`):
 *
 *   - a single windowed `event` criterion → its `eventName` (the last qualifying
 *     occurrence is the window boundary, e.g. the last `app_opened`).
 *   - the lapsed-active composite `all(event(X).exists(),
 *     event(X).within(W).not_exists())` → event X (the flagship went-dormant
 *     shape; the last X is when they lapsed).
 *
 * Other shapes (property/count composites, OR-of-absence, multi-event) have no
 * single cheap per-matcher timestamp, so they keep a NULL anchor.
 */
function resolveDwellAnchorEvent(criteria: ConditionEval): string | null {
  if (criteria.type === "event") {
    return criteria.within != null ? criteria.eventName : null;
  }
  // Lapsed-active composite — two legs on the SAME event X: an unwindowed
  // exists() anchor and a windowed not_exists() leg. Mirrors
  // isLapsedActiveComposite in bucket-reconcile.ts.
  if (
    criteria.type === "composite" &&
    criteria.operator === "and" &&
    criteria.conditions.length === 2
  ) {
    const existsLeg = criteria.conditions.find(
      (c) => c.type === "event" && c.check === "exists" && c.within == null,
    );
    const notExistsLeg = criteria.conditions.find(
      (c) => c.type === "event" && c.check === "not_exists" && c.within != null,
    );
    if (
      existsLeg?.type === "event" &&
      notExistsLeg?.type === "event" &&
      existsLeg.eventName === notExistsLeg.eventName
    ) {
      return notExistsLeg.eventName;
    }
  }
  return null;
}

/**
 * Upsert the bucket's current criteria fingerprint onto `bucket_configs` (Section
 * 6.6 B). Mirrors the admin enable/disable onConflictDoUpdate target.
 */
async function persistCriteriaHash(
  db: Database,
  bucket: BucketMeta,
): Promise<void> {
  const hash = computeCriteriaHash(bucket.criteria);
  await db
    .insert(bucketConfigs)
    .values({ bucketId: bucket.id, criteriaHash: hash })
    .onConflictDoUpdate({
      target: bucketConfigs.bucketId,
      set: { criteriaHash: hash, updatedAt: new Date() },
    });
}

/**
 * Detect first-time / criteria-changed buckets at worker boot and enqueue a
 * backfill / re-eval job per bucket (Section 6.6 B). For each enabled dynamic
 * bucket: read the stored `bucket_configs.criteriaHash`; if absent → first-time
 * backfill; if present but different → re-eval; if equal → no-op. Creates an
 * `import_jobs` status record (discriminated by `format`) and pushes
 * `bucketBackfillTask.run(...)` for it.
 *
 * Idempotent and safe to call on every boot — equal hashes are skipped. Best-effort
 * (a failure to enqueue must not crash worker boot).
 */
export async function enqueueBucketBackfills(opts: {
  db: Database;
  logger: Logger;
}): Promise<void> {
  const { db, logger } = opts;
  const registry = getBucketRegistrySingleton();

  for (const bucket of registry.getEnabled()) {
    if (bucket.kind === "manual" || !bucket.criteria) continue;

    try {
      const config = await db.query.bucketConfigs.findFirst({
        where: eq(bucketConfigs.bucketId, bucket.id),
      });
      const currentHash = computeCriteriaHash(bucket.criteria);

      let mode: BucketBackfillInput["mode"] | null = null;
      if (!config || config.criteriaHash == null) {
        mode = "first-time";
      } else if (config.criteriaHash !== currentHash) {
        mode = "reeval";
      }
      if (!mode) continue;

      const [job] = await db
        .insert(importJobs)
        .values({
          fileName: bucket.id,
          format: mode === "first-time" ? FIRST_TIME_FORMAT : REEVAL_FORMAT,
          status: "pending",
        })
        .returning({ id: importJobs.id });

      if (!job) continue;

      // runNoWait (fire-and-forget): this is called from worker boot BEFORE the
      // listener starts, so awaiting the run would deadlock (the run needs the
      // listener that `_worker.start()` brings up). The triggered run queues and
      // executes once listening; the task itself persists the criteriaHash.
      await bucketBackfillTask.runNoWait({
        jobId: job.id,
        bucketId: bucket.id,
        mode,
      });

      logger.info("Bucket backfill enqueued", {
        bucketId: bucket.id,
        mode,
        jobId: job.id,
      });
    } catch (err) {
      logger.warn("Bucket backfill enqueue failed", {
        bucketId: bucket.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
