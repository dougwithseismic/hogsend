import { createHash } from "node:crypto";
import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BucketMeta,
  type ConditionEval,
  type DurationObject,
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
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getBucketRegistrySingleton } from "../buckets/registry-singleton.js";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { emitBucketTransition } from "../lib/bucket-emit.js";
import { hatchet } from "../lib/hatchet.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";

/** Insert chunk size, reusing the import-contacts precedent (Section 6.6). */
const BATCH_SIZE = 500;

/** import_jobs.format discriminator for the reused status record (Section 6.6). */
const FIRST_TIME_FORMAT = "bucket-backfill";
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
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

  let inserted = 0;
  for (let i = 0; i < matcherIds.length; i += BATCH_SIZE) {
    const chunk = matcherIds.slice(i, i + BATCH_SIZE);

    // userEmail backfilled from the contacts row where available.
    const chunkContacts = await db
      .select({ externalId: contacts.externalId, email: contacts.email })
      .from(contacts)
      .where(
        and(inArray(contacts.externalId, chunk), isNull(contacts.deletedAt)),
      );
    const emailByUser = new Map(
      chunkContacts.map((c) => [c.externalId, c.email]),
    );

    const rows = chunk.map((userId) => ({
      userId,
      userEmail: emailByUser.get(userId) ?? null,
      bucketId: bucket.id,
      status: "active" as const,
      source: "backfill" as const,
      entryCount: 1,
      expiresAt: computeBackfillExpiresAt(bucket),
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
  // (absence) → live contacts with NO such event in the window (anti-join).
  if (criteria.check === "not_exists") {
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
      .select({ userId: contacts.externalId })
      .from(contacts)
      .leftJoin(present, eq(present.userId, contacts.externalId))
      .where(and(isNull(contacts.deletedAt), isNull(present.userId)));
    return rows.map((r) => r.userId);
  }

  // exists / count: group counts then filter by the operator.
  const rows = await db
    .select({
      userId: userEvents.userId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.event, criteria.eventName),
        cutoff ? gte(userEvents.occurredAt, cutoff) : undefined,
      ),
    )
    .groupBy(userEvents.userId);

  return rows
    .filter((r) => matchesCount(criteria, Number(r.cnt)))
    .map((r) => r.userId);
}

/** True when a windowed count satisfies the (exists/count) criterion. */
function matchesCount(
  criteria: Extract<ConditionEval, { type: "event" }>,
  count: number,
): boolean {
  switch (criteria.check) {
    case "exists":
      return count > 0;
    case "count": {
      if (!criteria.operator || criteria.value === undefined) return count > 0;
      switch (criteria.operator) {
        case "gt":
          return count > criteria.value;
        case "gte":
          return count >= criteria.value;
        case "lt":
          return count < criteria.value;
        case "lte":
          return count <= criteria.value;
        case "eq":
          return count === criteria.value;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Composite/multi-condition fallback (the documented O(P) exception, Section 6.6):
 * a chunked per-contact `evaluateCondition` loop over live contacts. Property
 * sub-conditions evaluate against the contact's merged properties.
 */
async function selectCompositeMatchers(
  db: Database,
  criteria: ConditionEval,
): Promise<string[]> {
  const liveContacts = await db
    .select({
      externalId: contacts.externalId,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(isNull(contacts.deletedAt));

  const matchers: string[] = [];
  for (const contact of liveContacts) {
    const isMember = await evaluateCondition({
      condition: criteria,
      ctx: {
        db,
        userId: contact.externalId,
        journeyContext:
          (contact.properties as Record<string, unknown> | null) ?? {},
      },
    });
    if (isMember) matchers.push(contact.externalId);
  }
  return matchers;
}

/** now + within for time-based / fastExpiry buckets; null otherwise. */
function computeBackfillExpiresAt(bucket: BucketMeta): Date | null {
  if (!bucket.criteria) return null;
  if (!bucket.timeBased && !bucket.fastExpiry) return null;
  const within = firstWithin(bucket.criteria);
  if (!within) return null;
  return new Date(Date.now() + durationToMs(within));
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

      await bucketBackfillTask.run({
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
