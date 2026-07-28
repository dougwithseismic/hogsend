import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  contacts,
  createDatabase,
  type Database,
  importJobs,
} from "@hogsend/db";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { contactKeySql } from "../lib/contacts.js";
import { hatchet } from "../lib/hatchet.js";
import type { Logger } from "../lib/logger.js";
import { createLogger } from "../lib/logger.js";

/**
 * PRD 04 T5 — fill the five history tables' `contact_id` bookkeeping column for
 * rows that predate the dual-write (and for rows a best-effort dual-write
 * missed, D6).
 *
 * NEVER a migration (`docs/UPGRADING.md:82-87`): this is a chunked, paced,
 * resumable Hatchet task, modelled on `identity-alias-backfill.ts` — an
 * `import_jobs` progress row, boot-enqueued, forceable from admin.
 *
 * Shape, per D3/D4:
 *  - PASS 1 iterates **contacts**, not events. Per live contact it derives the
 *    canonical key (`contactKeySql()` = `external_id ?? anonymous_id ?? id`) and
 *    issues one bounded `UPDATE … WHERE id IN (SELECT id … WHERE user_id = $key
 *    AND contact_id IS NULL LIMIT $n)` per table, looped to zero. Every table
 *    has a leading `user_id` index, so no statement seq-scans `user_events`.
 *  - PASS 2 fills rows keyed on a STALE key that only `contact_aliases` knows,
 *    restricted to kinds `external`/`anonymous` (the only kinds a canonical key
 *    can ever be). A value owned by more than one live contact across those two
 *    kinds is SKIPPED and logged — never guessed (D4).
 *
 * Invariants, each pinned by a test:
 *  - **Only `contact_id` is ever written.** No inserts, no deletes, no other
 *    column touched (not even `updated_at` — the statements set one column).
 *  - **`contact_id IS NULL` guards every UPDATE**, so a re-run, a resume, or the
 *    periodic re-sweep (D6) updates zero rows and costs only the probes.
 *  - **A row whose key owns NO live contact stays NULL. Forever** (D5). The
 *    completion criterion is not "zero NULLs"; T6's probe is what judges it.
 *  - **Not a repair tool.** A row already carrying a WRONG non-NULL value is
 *    left alone by design (risk 3) — the fix for that is a targeted corrective
 *    job, not this sweep.
 */

/** `import_jobs.format` discriminator for the reused status record. */
export const CONTACT_ID_BACKFILL_FORMAT = "identity-contact-id-backfill";

/** The five string-keyed history tables carrying the column (D1). */
const TABLES = [
  "user_events",
  "journey_states",
  "bucket_memberships",
  "email_sends",
  "email_preferences",
] as const;

export type ContactIdBackfillTable = (typeof TABLES)[number];

/** Per-table row counts. A mapped type (not an interface) so it carries the
 * implicit index signature the Hatchet `JsonObject` return contract needs. */
export type ContactIdBackfillCounts = Record<ContactIdBackfillTable, number>;

/** Live contacts per keyset chunk — the `bucket-backfill.ts` precedent. */
const DEFAULT_CONTACTS_PER_CHUNK = 500;
/** Rows per UPDATE statement. The sizing RULE (D3) is what matters: keep any
 * single statement under ~1s and ~10,000 row locks. This default is a guess
 * about someone else's data; measure and override per deployment. */
const DEFAULT_ROWS_PER_STATEMENT = 5_000;
/** Pause after a statement that actually wrote, so autovacuum keeps up with the
 * dead tuples a non-HOT (indexed column) update leaves behind (D3). */
const DEFAULT_PAUSE_MS = 25;
/** Runaway guard: a per-(contact, table) loop that never drains is a bug, not a
 * big table. 5,000 iterations × the default cap is 25M rows for ONE key. */
const MAX_STATEMENTS_PER_LOOP = 5_000;
/** D6 — how stale the newest COMPLETED sweep may be before boot re-enqueues. */
const DEFAULT_RESWEEP_HOURS = 24;
/** Ambiguous alias values logged per run (the rest are counted only). */
const AMBIGUOUS_SAMPLE = 20;

export interface ContactIdBackfillInput extends JsonObject {
  /** `import_jobs` row to record progress on. Optional: the task body runs
   * standalone (tests, operator scripts) without one. */
  jobId?: string;
  /** Live contacts read per keyset chunk. Default 500. */
  contactsPerChunk?: number;
  /** Rows per bounded UPDATE. Default 5,000. */
  rowsPerStatement?: number;
  /** Milliseconds to pause after a statement that wrote. Default 25. */
  pauseMs?: number;
}

// Extends JsonObject: this is a Hatchet task return value and must be
// JSON-serializable (the constraint every workflow output carries).
export interface ContactIdBackfillResult extends JsonObject {
  status: "completed" | "failed";
  /** Live contacts visited by pass 1. */
  contactsScanned: number;
  /** Rows stamped by pass 1, per table (the canonical-key population). */
  canonical: ContactIdBackfillCounts;
  /** Rows stamped by pass 2, per table (the stale-alias population). */
  alias: ContactIdBackfillCounts;
  /** `canonical + alias` across all five tables — the number a re-run must
   * report as 0 (the idempotence assertion). */
  updated: number;
  /** Alias VALUES owned by more than one live contact across the two permitted
   * kinds. Skipped, never guessed (D4); a non-zero count wants a human. */
  ambiguousAliases: number;
  /** UPDATE statements issued. Observability for the pacing rule. */
  statements: number;
  reason?: string;
}

const zeroCounts = (): ContactIdBackfillCounts => ({
  user_events: 0,
  journey_states: 0,
  bucket_memberships: 0,
  email_sends: 0,
  email_preferences: 0,
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Positive-integer option with a documented default; a nonsense value falls
 * back rather than producing an unbounded or zero-progress statement. */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * PASS 1, one table, one contact. The PRD's verbatim statement (D3), looped
 * until it affects zero rows. Returns rows stamped and statements issued.
 *
 * The `IN (SELECT … LIMIT n)` shape (rather than a bare `WHERE user_id = …`) is
 * what bounds the row-lock count: the fat tail of this system is a bot anon id
 * with tens of thousands of events under ONE key, and an unbounded statement
 * there is the lock/WAL spike D3 exists to avoid.
 */
async function fillCanonicalKey(opts: {
  db: Database;
  table: ContactIdBackfillTable;
  key: string;
  contactId: string;
  rowsPerStatement: number;
  pauseMs: number;
}): Promise<{ updated: number; statements: number }> {
  const { db, table, key, contactId, rowsPerStatement, pauseMs } = opts;
  const name = sql.identifier(table);
  let updated = 0;
  let statements = 0;

  for (;;) {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE ${name} SET contact_id = ${contactId}::uuid
       WHERE id IN (
         SELECT id FROM ${name}
          WHERE user_id = ${key} AND contact_id IS NULL
          LIMIT ${rowsPerStatement}
       )
      RETURNING id
    `);
    statements += 1;
    if (rows.length === 0) return { updated, statements };
    updated += rows.length;

    if (statements >= MAX_STATEMENTS_PER_LOOP) {
      throw new Error(
        `contact-id backfill: ${table} did not drain for key after ` +
          `${statements} statements (${updated} rows) — refusing to loop`,
      );
    }
    // Only a statement that WROTE created dead tuples, so only that one earns
    // the pause. Without this the steady-state re-sweep (D6) would idle for
    // 5 × pauseMs per contact while updating nothing.
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

/**
 * The set of alias values that resolve UNAMBIGUOUSLY to one live contact, under
 * the two kinds a canonical key can be. `uniqueIndex(alias_kind, alias_value)`
 * is per-KIND, so one string can legally sit under both `external` and
 * `anonymous`; when those disagree on the contact this CTE drops the value (the
 * `HAVING count(DISTINCT …) = 1` clause) and `countAmbiguousAliases` reports it.
 *
 * `array_agg(…)[1]` rather than `min()`: `min(uuid)` only exists from PG 14, and
 * the aggregate choice is irrelevant when the HAVING proves there is exactly one
 * distinct value.
 */
const resolvedAliasesCte = sql`
  resolved AS (
    SELECT a.alias_value AS alias_key,
           (array_agg(a.contact_id ORDER BY a.contact_id))[1] AS contact_id
      FROM contact_aliases a
      JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
     WHERE a.alias_kind IN ('external', 'anonymous')
     GROUP BY a.alias_value
    HAVING count(DISTINCT a.contact_id) = 1
  )`;

/** D4's skip rule, measured: alias values whose two permitted kinds point at
 * DIFFERENT live contacts. Never resolved; reported so a human can. */
async function countAmbiguousAliases(
  db: Database,
): Promise<{ total: number; sample: string[] }> {
  const rows = await db.execute<{ alias_value: string }>(sql`
    SELECT a.alias_value
      FROM contact_aliases a
      JOIN contacts c ON c.id = a.contact_id AND c.deleted_at IS NULL
     WHERE a.alias_kind IN ('external', 'anonymous')
     GROUP BY a.alias_value
    HAVING count(DISTINCT a.contact_id) > 1
  `);
  return {
    total: rows.length,
    sample: rows.slice(0, AMBIGUOUS_SAMPLE).map((r) => r.alias_value),
  };
}

/**
 * PASS 2's work list: alias values that resolve to exactly one live contact AND
 * are NOT already the canonical key of some live contact — i.e. precisely the
 * stale/second-device population pass 1 cannot reach.
 *
 * The `NOT EXISTS` exclusion is not just an optimisation: an alias value that IS
 * a live contact's canonical key was already fully drained by pass 1 (every row
 * under that key is now non-NULL), so re-visiting it can only issue zero-row
 * probes. Excluding it keeps pass 2 proportional to the merge/promote
 * population rather than to the whole alias table (which, post-PRD-02, holds
 * roughly one row per identity column per live contact — C2).
 *
 * Keyset-paginated on `alias_key` so the work list itself is bounded too.
 */
async function selectStaleAliasKeys(opts: {
  db: Database;
  afterKey: string | null;
  limit: number;
}): Promise<Array<{ key: string; contactId: string }>> {
  const { db, afterKey, limit } = opts;
  const rows = await db.execute<{ alias_key: string; contact_id: string }>(sql`
    WITH ${resolvedAliasesCte}
    SELECT r.alias_key, r.contact_id::text AS contact_id
      FROM resolved r
     WHERE (${afterKey}::text IS NULL OR r.alias_key > ${afterKey}::text)
       AND NOT EXISTS (
         SELECT 1 FROM contacts
          WHERE contacts.deleted_at IS NULL
            AND ${contactKeySql()} = r.alias_key
       )
     ORDER BY r.alias_key
     LIMIT ${limit}
  `);
  return rows.map((r) => ({ key: r.alias_key, contactId: r.contact_id }));
}

/**
 * The task body, exported directly so tests and operator scripts can run it
 * without a Hatchet engine. `jobId` is optional; when present, progress lands on
 * the `import_jobs` row (`totalRows` = live contacts, `processedRows` = contacts
 * done, `failedRows` = ambiguous alias values skipped — a divergence metric, NOT
 * an error count).
 *
 * RESUME is free rather than bookkept: an interrupted run is re-driven from the
 * top, re-reads live contacts ordered by `id`, and every UPDATE's
 * `contact_id IS NULL` guard makes an already-done contact a single zero-row
 * probe per table. No cursor is persisted because none is needed.
 */
export async function runContactIdBackfill(opts: {
  db: Database;
  logger: Logger;
  jobId?: string;
  contactsPerChunk?: number;
  rowsPerStatement?: number;
  pauseMs?: number;
}): Promise<ContactIdBackfillResult> {
  const { db, logger, jobId } = opts;
  const contactsPerChunk = positiveInt(
    opts.contactsPerChunk,
    DEFAULT_CONTACTS_PER_CHUNK,
  );
  const rowsPerStatement = positiveInt(
    opts.rowsPerStatement,
    DEFAULT_ROWS_PER_STATEMENT,
  );
  const pauseMs =
    opts.pauseMs === undefined
      ? DEFAULT_PAUSE_MS
      : Number.isFinite(opts.pauseMs) && opts.pauseMs >= 0
        ? Math.floor(opts.pauseMs)
        : DEFAULT_PAUSE_MS;

  const canonical = zeroCounts();
  const alias = zeroCounts();
  let contactsScanned = 0;
  let statements = 0;
  let ambiguousAliases = 0;

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
    const [totals] = await db.execute<{ live: number }>(sql`
      SELECT count(*)::int AS live FROM contacts WHERE deleted_at IS NULL
    `);
    await markJob({
      status: "processing",
      totalRows: Number(totals?.live ?? 0),
    });

    // ---- PASS 1: the canonical key of every live contact (D3) --------------
    const resolvedKey = contactKeySql();
    let cursor: string | null = null;
    for (;;) {
      const chunk = await db
        .select({ id: contacts.id, key: resolvedKey })
        .from(contacts)
        .where(
          and(
            isNull(contacts.deletedAt),
            cursor ? gt(contacts.id, cursor) : undefined,
          ),
        )
        .orderBy(contacts.id)
        .limit(contactsPerChunk);
      if (chunk.length === 0) break;

      for (const row of chunk) {
        for (const table of TABLES) {
          const filled = await fillCanonicalKey({
            db,
            table,
            key: row.key,
            contactId: row.id,
            rowsPerStatement,
            pauseMs,
          });
          canonical[table] += filled.updated;
          statements += filled.statements;
        }
      }

      contactsScanned += chunk.length;
      cursor = chunk[chunk.length - 1]?.id ?? null;
      await markJob({ processedRows: contactsScanned });
      if (chunk.length < contactsPerChunk) break;
    }

    // ---- PASS 2: stale keys only `contact_aliases` knows (D4) --------------
    const ambiguous = await countAmbiguousAliases(db);
    ambiguousAliases = ambiguous.total;
    if (ambiguousAliases > 0) {
      logger.warn("Contact-id backfill skipped ambiguous alias values", {
        count: ambiguousAliases,
        sample: ambiguous.sample,
      });
    }

    let aliasCursor: string | null = null;
    for (;;) {
      const staleKeys = await selectStaleAliasKeys({
        db,
        afterKey: aliasCursor,
        limit: contactsPerChunk,
      });
      if (staleKeys.length === 0) break;

      for (const entry of staleKeys) {
        for (const table of TABLES) {
          const filled = await fillCanonicalKey({
            db,
            table,
            key: entry.key,
            contactId: entry.contactId,
            rowsPerStatement,
            pauseMs,
          });
          alias[table] += filled.updated;
          statements += filled.statements;
        }
      }

      aliasCursor = staleKeys[staleKeys.length - 1]?.key ?? null;
      if (staleKeys.length < contactsPerChunk) break;
    }

    const updated =
      TABLES.reduce((sum, t) => sum + canonical[t], 0) +
      TABLES.reduce((sum, t) => sum + alias[t], 0);

    await markJob({
      status: "completed",
      processedRows: contactsScanned,
      failedRows: ambiguousAliases,
    });
    logger.info("Contact-id backfill complete", {
      contactsScanned,
      canonical,
      alias,
      updated,
      ambiguousAliases,
      statements,
    });
    return {
      status: "completed",
      contactsScanned,
      canonical,
      alias,
      updated,
      ambiguousAliases,
      statements,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJob({
      status: "failed",
      errors: [{ row: 0, error: message }],
    }).catch(() => undefined);
    logger.error("Contact-id backfill failed", { message });
    return {
      status: "failed",
      contactsScanned,
      canonical,
      alias,
      updated:
        TABLES.reduce((sum, t) => sum + canonical[t], 0) +
        TABLES.reduce((sum, t) => sum + alias[t], 0),
      ambiguousAliases,
      statements,
      reason: message,
    };
  }
}

export const contactIdBackfillTask = hatchet.task({
  name: "identity-contact-id-backfill",
  retries: 0,
  // Longer than the alias backfill's 600s: this one walks every live contact
  // against the two largest tables in the system. A run that outlives the
  // timeout is not lost — the next re-sweep resumes it for free.
  executionTimeout: "3600s",
  fn: async (input: ContactIdBackfillInput) => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    return runContactIdBackfill({
      db,
      logger,
      jobId: input.jobId,
      contactsPerChunk: input.contactsPerChunk,
      rowsPerStatement: input.rowsPerStatement,
      pauseMs: input.pauseMs,
    });
  },
});

/**
 * D6 — how stale the newest COMPLETED sweep may be before boot runs another.
 * Read raw off `process.env` (the `OUTBOUND_WEBHOOK_*` tunable stance) and
 * validated here: a missing, non-numeric or non-positive value falls back to 24
 * hours rather than disabling the sweep or hammering it.
 */
export function contactIdResweepIntervalMs(logger?: Logger): number {
  const raw = process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_RESWEEP_HOURS * 60 * 60 * 1000;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    logger?.warn("Ignoring invalid CONTACT_ID_BACKFILL_RESWEEP_HOURS", {
      value: raw,
      fallbackHours: DEFAULT_RESWEEP_HOURS,
    });
    return DEFAULT_RESWEEP_HOURS * 60 * 60 * 1000;
  }
  return hours * 60 * 60 * 1000;
}

/**
 * Worker-boot enqueue. Unlike the alias backfill's once-per-deployment gate,
 * this is a **periodic reconcile sweep** (D6, revised): the dual-write is
 * best-effort, so "T5 will fill it later" only holds while a later T5 exists.
 * A run therefore starts when EITHER
 *   - no completed job of this format exists yet, OR
 *   - the newest completed one is older than `CONTACT_ID_BACKFILL_RESWEEP_HOURS`
 *     (default 24h).
 * A `pending`/`processing` row always wins — two sweeps must never stack. (A
 * run killed hard enough to never mark its row terminal therefore parks the
 * boot sweep until an operator marks it failed; `POST
 * /v1/admin/maintenance/backfill-contact-id` bypasses this guard entirely and
 * is the escape hatch.)
 *
 * Re-running is cheap by construction: every UPDATE is guarded by
 * `contact_id IS NULL`, so a steady-state sweep is five zero-row probes per
 * contact and writes nothing. Boot-triggered rather than operator-triggered
 * deliberately — the engine is a published dependency, and a manual step every
 * consumer must remember is how deployments strand at PRD 05. Best-effort: a
 * failure to enqueue must never crash worker boot.
 */
export async function enqueueContactIdBackfill(opts: {
  db: Database;
  logger: Logger;
}): Promise<void> {
  const { db, logger } = opts;
  try {
    const inflight = await db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT),
          inArray(importJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    if (inflight[0]) return;

    const [latest] = await db
      .select({ id: importJobs.id, updatedAt: importJobs.updatedAt })
      .from(importJobs)
      .where(
        and(
          eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT),
          eq(importJobs.status, "completed"),
        ),
      )
      .orderBy(desc(importJobs.updatedAt))
      .limit(1);

    const intervalMs = contactIdResweepIntervalMs(logger);
    if (latest && Date.now() - latest.updatedAt.getTime() < intervalMs) return;

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: CONTACT_ID_BACKFILL_FORMAT,
        format: CONTACT_ID_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) return;

    // runNoWait: called from worker boot BEFORE the listener starts — awaiting
    // the run would deadlock (the `enqueueBucketBackfills` reasoning).
    await contactIdBackfillTask.runNoWait({ jobId: job.id });
    logger.info("Contact-id backfill enqueued", {
      jobId: job.id,
      previousSweepAt: latest?.updatedAt.toISOString() ?? null,
      resweepIntervalMs: intervalMs,
    });
  } catch (err) {
    logger.warn("Contact-id backfill enqueue failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
