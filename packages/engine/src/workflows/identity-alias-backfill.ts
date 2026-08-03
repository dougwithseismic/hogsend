import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import { createDatabase, type Database, importJobs } from "@hogsend/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ALIAS_REASON_BACKFILL } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";

/** `import_jobs.format` discriminator for the reused status record. */
export const IDENTITY_ALIAS_BACKFILL_FORMAT = "identity-alias-backfill";

/** Contacts per keyset batch — the `bucket-backfill.ts` precedent. */
const BATCH_SIZE = 500;

/**
 * PRD 02 T3 — fill `contact_aliases` with a row per identity key of every LIVE
 * contact, so the identity table can become the source of truth `findByKey`
 * reads first. Keyset-paginated on the `contacts` PK; one classify SELECT plus
 * one guarded INSERT per batch; no long-held transaction, no table lock.
 *
 * Invariants, each pinned by a test:
 *  - IDEMPOTENT — `ON CONFLICT (alias_kind, alias_value) DO NOTHING` against
 *    the plain unique index; a re-run (or a resume from zero) inserts nothing.
 *  - NEVER STEALS — a `(kind, value)` already claimed by a DIFFERENT contact is
 *    skipped and counted (`conflicting`), never repointed.
 *  - Soft-deleted contacts are EXCLUDED (`deleted_at IS NULL`): their keys are
 *    either a merged loser's (already aliased to the survivor by
 *    `recordMergeAliases`) or an erased person's (must not be resurrected).
 *  - Emails land NORMALIZED (`lower(trim(email))`) so the alias row matches the
 *    value the resolver's probes always compare against.
 *  - The row-uuid pseudo-key (`('external', contacts.id)`) is deliberately NOT
 *    backfilled — on a deployment using uuids as external ids it would contend
 *    with real keys, a history-theft-shaped outcome for a defensive row. The
 *    uuid probe stays last in `findByKey` instead.
 */
export interface IdentityAliasBackfillInput extends JsonObject {
  jobId: string;
  /** Classify + count only; write nothing. Also reports the mixed-case email
   * count (the datum behind PRD 02 T6's per-deployment decision). */
  dryRun?: boolean;
}

// Extends JsonObject: this is a Hatchet task return value and must be
// JSON-serializable (the same constraint every workflow output carries).
export interface IdentityAliasBackfillResult extends JsonObject {
  status: "completed" | "failed";
  dryRun: boolean;
  /** Live contacts scanned. */
  scanned: number;
  /** Alias rows written (projected, in a dry run). */
  inserted: number;
  /** Pairs already aliased to the SAME contact (benign; dominated by the
   * dual-write once it has been live for a while). */
  present: number;
  /** Pairs whose `(kind, value)` is claimed by a DIFFERENT contact — the
   * divergence metric. Never repointed; surfaced via the parity endpoint. */
  conflicting: number;
  /** Live contacts whose stored email differs from `lower(trim(email))` —
   * re-measure per deployment before trusting the read flip for email (T6). */
  mixedCaseEmails: number;
  reason?: string;
}

/** The four identity-column → alias-kind projections of one contacts batch.
 * Fragment shared by the classify SELECT and the INSERT so the two can never
 * disagree about what a "pair" is. */
function pairsCte(afterId: string | null) {
  return sql`
    batch AS (
      SELECT id, external_id, email, anonymous_id, discord_id
        FROM contacts
       WHERE deleted_at IS NULL
         AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
       ORDER BY id
       LIMIT ${BATCH_SIZE}
    ),
    pairs AS (
      SELECT id, 'external'::text AS kind, external_id AS value
        FROM batch WHERE external_id IS NOT NULL
      UNION ALL
      SELECT id, 'email', lower(trim(email))
        FROM batch WHERE email IS NOT NULL AND trim(email) <> ''
      UNION ALL
      SELECT id, 'anonymous', anonymous_id
        FROM batch WHERE anonymous_id IS NOT NULL
      UNION ALL
      SELECT id, 'discord', discord_id
        FROM batch WHERE discord_id IS NOT NULL
    )`;
}

interface BatchClassification {
  scanned: number;
  lastId: string | null;
  toInsert: number;
  present: number;
  conflicting: number;
}

/** One round trip: how many contacts this batch scans, where the cursor lands,
 * and how each candidate pair classifies against the existing alias rows. */
async function classifyBatch(
  db: Database,
  afterId: string | null,
): Promise<BatchClassification> {
  const rows = await db.execute<{
    scanned: number;
    last_id: string | null;
    to_insert: number;
    present: number;
    conflicting: number;
  }>(sql`
    WITH ${pairsCte(afterId)},
    classified AS (
      SELECT p.id, a.contact_id AS owner
        FROM pairs p
        LEFT JOIN contact_aliases a
          ON a.alias_kind = p.kind AND a.alias_value = p.value
    )
    SELECT (SELECT count(*) FROM batch)::int AS scanned,
           -- no max(uuid) aggregate exists; take the keyset tail explicitly
           (SELECT id FROM batch ORDER BY id DESC LIMIT 1)::text AS last_id,
           count(*) FILTER (WHERE c.owner IS NULL)::int   AS to_insert,
           count(*) FILTER (WHERE c.owner = c.id)::int    AS present,
           count(*) FILTER (WHERE c.owner IS NOT NULL
                              AND c.owner <> c.id)::int   AS conflicting
      FROM classified c
  `);
  const row = rows[0];
  return {
    scanned: Number(row?.scanned ?? 0),
    lastId: row?.last_id ?? null,
    toInsert: Number(row?.to_insert ?? 0),
    present: Number(row?.present ?? 0),
    conflicting: Number(row?.conflicting ?? 0),
  };
}

/** True when the error chain carries a Postgres FK violation (23503). Drizzle
 * wraps the driver error, so walk `cause` (the 23505 lesson from the partial-
 * index onConflict work applies to every SQLSTATE). */
function isFkViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let i = 0; i < 5 && cursor; i++) {
    if (
      typeof cursor === "object" &&
      "code" in cursor &&
      (cursor as { code?: unknown }).code === "23503"
    ) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The write half — the PRD's verbatim statement. Returns rows inserted.
 *
 * Retries (bounded) on an FK violation: a contact HARD-deleted between this
 * statement's snapshot and its inserts (a GDPR purge script, a test cleanup)
 * makes the alias row's `contact_id` FK fail even though the batch CTE read the
 * row as live. Each retry re-reads the batch under a fresh snapshot — the
 * deleted contact is gone from it — so a racing purge costs a retry, not the
 * whole job. Any other error, or a third consecutive FK loss, propagates.
 */
async function insertBatch(db: Database, afterId: string | null) {
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await db.execute<{ contact_id: string }>(sql`
        WITH ${pairsCte(afterId)}
        INSERT INTO contact_aliases
          (contact_id, alias_kind, alias_value, from_contact_id, reason,
           created_at, updated_at)
        SELECT id, kind, value, NULL, ${ALIAS_REASON_BACKFILL}, now(), now()
          FROM pairs
        ON CONFLICT (alias_kind, alias_value) DO NOTHING
        RETURNING contact_id
      `);
      return rows.length;
    } catch (err) {
      if (attempt >= 2 || !isFkViolation(err)) throw err;
    }
  }
}

/**
 * The task body, exported directly so tests and operator scripts can run it
 * without a Hatchet engine. `jobId` is optional: when present, progress is
 * recorded on the `import_jobs` row (`processedRows` = contacts scanned,
 * `failedRows` = conflicting pairs — the divergence metric, NOT an error
 * count; the full breakdown is in the return value and the completion log).
 */
export async function runIdentityAliasBackfill(opts: {
  db: Database;
  logger: Logger;
  jobId?: string;
  dryRun?: boolean;
}): Promise<IdentityAliasBackfillResult> {
  const { db, logger, jobId } = opts;
  const dryRun = opts.dryRun === true;

  const markJob = async (
    patch: Partial<typeof importJobs.$inferInsert>,
  ): Promise<void> => {
    if (!jobId) return;
    await db
      .update(importJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(importJobs.id, jobId));
  };

  try {
    const [totals] = await db.execute<{ live: number; mixed: number }>(sql`
      SELECT count(*)::int AS live,
             count(*) FILTER (
               WHERE email IS NOT NULL
                 AND email IS DISTINCT FROM lower(trim(email))
             )::int AS mixed
        FROM contacts
       WHERE deleted_at IS NULL
    `);
    const mixedCaseEmails = Number(totals?.mixed ?? 0);
    await markJob({
      status: "processing",
      totalRows: Number(totals?.live ?? 0),
    });

    let cursor: string | null = null;
    let scanned = 0;
    let inserted = 0;
    let present = 0;
    let conflicting = 0;

    for (;;) {
      const batch = await classifyBatch(db, cursor);
      if (batch.scanned === 0) break;

      if (!dryRun) {
        // The classify → insert pair is two statements, so a resolve committing
        // between them can shrink the insert below `toInsert` — the INSERT's
        // own ON CONFLICT arbiter is the correctness guard; the counts are
        // observability. Count what actually landed.
        inserted += await insertBatch(db, cursor);
      } else {
        inserted += batch.toInsert;
      }
      scanned += batch.scanned;
      present += batch.present;
      conflicting += batch.conflicting;
      cursor = batch.lastId;

      await markJob({ processedRows: scanned, failedRows: conflicting });
      if (batch.scanned < BATCH_SIZE) break;
    }

    if (!dryRun) {
      // ERASURE-RACE SWEEP. A contact erased WHILE this job runs can have its
      // keys re-inserted from a batch statement's stale snapshot (the batch
      // read the contact as live; the erasure hook's delete committed first;
      // this insert committed second). That would resurrect an erased person's
      // identity keys — the exact leak PRD 02 T1 exists to close. This final
      // statement runs AFTER every insert has committed, so its snapshot sees
      // any erasure that raced a batch: whichever of the two commits second
      // now cleans up. Scoped to backfill-authored rows — merge-trail aliases
      // pointing at a soft-deleted survivor are `recordMergeAliases`' business,
      // not this job's.
      const swept = await db.execute<{ id: string }>(sql`
        DELETE FROM contact_aliases a
         USING contacts c
         WHERE a.contact_id = c.id
           AND c.deleted_at IS NOT NULL
           AND a.reason = ${ALIAS_REASON_BACKFILL}
        RETURNING a.id
      `);
      if (swept.length > 0) {
        logger.warn("Identity alias backfill swept erased-contact rows", {
          swept: swept.length,
        });
        // Clamp: the sweep can also collect a PREVIOUS run's raced rows,
        // which this run never counted as inserts.
        inserted = Math.max(0, inserted - swept.length);
      }
    }

    await markJob({
      status: "completed",
      processedRows: scanned,
      failedRows: conflicting,
    });
    logger.info("Identity alias backfill complete", {
      dryRun,
      scanned,
      inserted,
      present,
      conflicting,
      mixedCaseEmails,
    });
    return {
      status: "completed",
      dryRun,
      scanned,
      inserted,
      present,
      conflicting,
      mixedCaseEmails,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJob({
      status: "failed",
      errors: [{ row: 0, error: message }],
    }).catch(() => undefined);
    logger.error("Identity alias backfill failed", { dryRun, message });
    return {
      status: "failed",
      dryRun,
      scanned: 0,
      inserted: 0,
      present: 0,
      conflicting: 0,
      mixedCaseEmails: 0,
      reason: message,
    };
  }
}

export const identityAliasBackfillTask = hatchet.task({
  name: "identity-alias-backfill",
  retries: 0,
  executionTimeout: "600s",
  fn: async (input: IdentityAliasBackfillInput) => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    return runIdentityAliasBackfill({
      db,
      logger,
      jobId: input.jobId,
      dryRun: input.dryRun === true,
    });
  },
});

/**
 * Worker-boot enqueue (mirrors `enqueueBucketBackfills`): fire the backfill
 * once per deployment without an operator having to remember it — the engine
 * is a published dependency, and a manual step every consumer must run before
 * the read flip is how deployments strand. Skips when ANY non-failed job of
 * this format exists (pending/processing/completed); a failed run re-enqueues
 * on the next boot, and `POST /v1/admin/identity/alias-backfill` forces a
 * re-run past a stale record. Re-running is always safe (ON CONFLICT DO
 * NOTHING), just not free — hence the skip. Best-effort: a failure to enqueue
 * must never crash worker boot.
 */
export async function enqueueIdentityAliasBackfill(opts: {
  db: Database;
  logger: Logger;
}): Promise<void> {
  const { db, logger } = opts;
  try {
    const existing = await db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.format, IDENTITY_ALIAS_BACKFILL_FORMAT),
          inArray(importJobs.status, ["pending", "processing", "completed"]),
        ),
      )
      .limit(1);
    if (existing[0]) return;

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: IDENTITY_ALIAS_BACKFILL_FORMAT,
        format: IDENTITY_ALIAS_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) return;

    // runNoWait: called from worker boot BEFORE the listener starts — awaiting
    // the run would deadlock (same reasoning as enqueueBucketBackfills).
    await identityAliasBackfillTask.runNoWait({ jobId: job.id, dryRun: false });
    logger.info("Identity alias backfill enqueued", { jobId: job.id });
  } catch (err) {
    logger.warn("Identity alias backfill enqueue failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// PRD 02 T4 — read-only parity verifier
// ---------------------------------------------------------------------------

export interface AliasParityRow {
  kind: string;
  /** Alias and column resolve to DIFFERENT live contacts. MUST be 0 before
   * trusting alias-first resolution; a non-zero value is a data bug to fix on
   * its own, never to flip over. */
  diverged: number;
  /** Alias target is dead/missing but a live column owner exists — expected,
   * handled by `findByKey`'s live-target fall-through. */
  aliasDead: number;
  /** Alias exists with no column owner — the merge/promote population, and
   * (after PRD 03) the point of the table. */
  aliasOnly: number;
}

/** "Would alias-first return a different contact than column-first?", per kind,
 * over every alias row. Pure read; no writes, no locks beyond the reads. */
export async function identityAliasParity(
  db: Database,
): Promise<AliasParityRow[]> {
  const rows = await db.execute<{
    alias_kind: string;
    diverged: number;
    alias_dead: number;
    alias_only: number;
  }>(sql`
    SELECT a.alias_kind,
           count(*) FILTER (WHERE ac.id IS NOT NULL AND cc.id IS NOT NULL
                              AND ac.id <> cc.id)::int AS diverged,
           count(*) FILTER (WHERE ac.id IS NULL
                              AND cc.id IS NOT NULL)::int AS alias_dead,
           count(*) FILTER (WHERE ac.id IS NOT NULL
                              AND cc.id IS NULL)::int AS alias_only
      FROM contact_aliases a
      LEFT JOIN contacts ac
        ON ac.id = a.contact_id AND ac.deleted_at IS NULL
      LEFT JOIN contacts cc
        ON cc.deleted_at IS NULL AND (
             (a.alias_kind = 'external'  AND cc.external_id = a.alias_value)
          OR (a.alias_kind = 'email'     AND lower(trim(cc.email)) = a.alias_value)
          OR (a.alias_kind = 'anonymous' AND cc.anonymous_id = a.alias_value)
          OR (a.alias_kind = 'discord'   AND cc.discord_id = a.alias_value))
     GROUP BY 1
     ORDER BY 1
  `);
  return rows.map((r) => ({
    kind: r.alias_kind,
    diverged: Number(r.diverged),
    aliasDead: Number(r.alias_dead),
    aliasOnly: Number(r.alias_only),
  }));
}
