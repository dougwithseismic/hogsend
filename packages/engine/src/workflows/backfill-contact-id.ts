import type { JsonObject } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  contacts,
  createDatabase,
  type Database,
  importJobs,
} from "@hogsend/db";
import { and, desc, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
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
  /** PRD 05 T3 — stale `email_preferences` rows whose opt-out state was folded
   * into the contact's already-stamped row for the same address, and which were
   * then deleted. The only rows this job ever removes. */
  preferencesFolded: number;
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

/** The three tables migration 0071 gives a CONTACT-scoped partial unique index
 * (PRD 05 T3). Everything below that special-cases a table keys off this set. */
const CONTACT_SCOPED_TABLES = new Set<ContactIdBackfillTable>([
  "journey_states",
  "bucket_memberships",
  "email_preferences",
]);

/**
 * PRD 05 T3 — "the owning contact ALREADY holds a row that this row's stamp
 * would duplicate", correlated to the row `t` and to an owner-id expression.
 *
 * The sweep is a FOURTH writer to the three contact-scoped unique indexes, and
 * the only one whose rows start OUTSIDE them: `contact_id IS NULL` is outside
 * every one of the three predicates, so it is the STAMP that moves a row in.
 * When the contact already owns a stamped twin (same live journey, same live
 * bucket, same address — exactly the population adoption creates by stamping
 * `contact_id` without rewriting `user_id`) the stamp raises 23505, and this
 * job's blanket catch would turn ONE such row into a failed job that abandons
 * the whole sweep — which the boot / 24h re-enqueue then re-hits forever.
 *
 * Each arm reproduces its index's WHERE clause EXACTLY. Keep in sync with:
 *   uq_contact_journey_active            packages/db/src/schema/journey-states.ts
 *   uq_contact_bucket_active             .../bucket-memberships.ts
 *   email_preferences_contact_email_idx  .../email-preferences.ts
 */
function contactScopedTwinExists(
  table: ContactIdBackfillTable,
  owner: SQL,
): SQL {
  switch (table) {
    case "journey_states":
      return sql`t.status IN ('active', 'waiting') AND EXISTS (
        SELECT 1 FROM journey_states x
         WHERE x.contact_id = ${owner}
           AND x.journey_id = t.journey_id
           AND x.status IN ('active', 'waiting'))`;
    case "bucket_memberships":
      return sql`t.status = 'active' AND t.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM bucket_memberships x
         WHERE x.contact_id = ${owner}
           AND x.bucket_id = t.bucket_id
           AND x.status = 'active'
           AND x.deleted_at IS NULL)`;
    case "email_preferences":
      return sql`EXISTS (
        SELECT 1 FROM email_preferences x
         WHERE x.contact_id = ${owner} AND x.email = t.email)`;
    default:
      return sql`false`;
  }
}

/**
 * PRD 05 T3 — the ONE fold this sweep performs. Everywhere else it only ever
 * fills a NULL column; `email_preferences` earns the exception because a stale
 * row left NULL is an OPT-OUT the flipped (contact-scoped) read will never see.
 *
 * Per stale-keyed NULL row whose contact already holds a row for the same
 * address: fold the stale state into the TWIN under the merge path's
 * `foldEmailPreferences` rule — OR the opt-outs (`unsubscribed_all`,
 * `suppressed`), union the categories with the twin winning a conflict EXCEPT
 * that FALSE always wins (an opt-out is never lost), which also means a grant
 * the twin never heard of (a stale `sms: true` consent) survives — then DELETE
 * the stale row so nothing is left outside the index. Never the other
 * direction: the twin is the row the flipped read resolves.
 *
 * Postgres runs every data-modifying CTE exactly once and to completion whether
 * or not the primary query reads it, so the fold lands before the delete; the
 * two touch disjoint rows (the twin is stamped, the stale row is not).
 */
async function foldStalePreferences(opts: {
  db: Database;
  key: string;
  contactId: string;
}): Promise<number> {
  const { db, key, contactId } = opts;
  const rows = await db.execute<{ id: string }>(sql`
    WITH stale AS (
      SELECT p.id, p.email, p.unsubscribed_all, p.suppressed, p.suppressed_at,
             p.bounce_count, p.last_bounce_at, p.categories
        FROM email_preferences p
       WHERE p.user_id = ${key}
         AND p.contact_id IS NULL
         AND EXISTS (
           SELECT 1 FROM email_preferences t
            WHERE t.contact_id = ${contactId}::uuid AND t.email = p.email
         )
    ), folded AS (
      UPDATE email_preferences t
         SET unsubscribed_all = t.unsubscribed_all OR s.unsubscribed_all,
             suppressed       = t.suppressed OR s.suppressed,
             suppressed_at    = least(t.suppressed_at, s.suppressed_at),
             bounce_count     = greatest(t.bounce_count, s.bounce_count),
             last_bounce_at   = least(t.last_bounce_at, s.last_bounce_at),
             categories       = coalesce(s.categories, '{}'::jsonb)
                             || coalesce(t.categories, '{}'::jsonb)
                             || coalesce((
               SELECT jsonb_object_agg(k.key, 'false'::jsonb)
                 FROM jsonb_each(coalesce(s.categories, '{}'::jsonb)) k
                WHERE k.value = 'false'::jsonb
             ), '{}'::jsonb),
             updated_at = now()
        FROM stale s
       WHERE t.contact_id = ${contactId}::uuid AND t.email = s.email
    )
    DELETE FROM email_preferences WHERE id IN (SELECT id FROM stale)
    RETURNING id
  `);
  return rows.length;
}

/**
 * PASS 1, one table, one contact. The PRD's verbatim statement (D3), looped
 * until it affects zero rows. Returns rows stamped and statements issued.
 *
 * The `IN (SELECT … LIMIT n)` shape (rather than a bare `WHERE user_id = …`) is
 * what bounds the row-lock count: the fat tail of this system is a bot anon id
 * with tens of thousands of events under ONE key, and an unbounded statement
 * there is the lock/WAL spike D3 exists to avoid.
 *
 * PRD 05 T3: on the three contact-scoped tables the inner SELECT also carries
 * {@link contactScopedTwinExists} as a NOT guard, so a row whose stamp would
 * collide is never selected — it is SKIPPED, not stamped and not repaired. The
 * sweep does not get to cancel a live enrollment or membership to make room;
 * `verifyContactIdBackfill` reports what it skipped as `duplicates` (not
 * `missing`) so the gate can still open and the triage list stays visible.
 * Skipping in the SELECT (rather than swallowing a 23505) also keeps the loop
 * terminating: a skipped row simply stops being a candidate.
 */
async function fillCanonicalKey(opts: {
  db: Database;
  table: ContactIdBackfillTable;
  key: string;
  contactId: string;
  rowsPerStatement: number;
  pauseMs: number;
}): Promise<{ updated: number; statements: number; folded: number }> {
  const { db, table, key, contactId, rowsPerStatement, pauseMs } = opts;
  const name = sql.identifier(table);
  let updated = 0;
  let statements = 0;
  let folded = 0;

  // Opt-outs first: a folded row is deleted, so it never reaches the guard.
  if (table === "email_preferences") {
    folded = await foldStalePreferences({ db, key, contactId });
    statements += 1;
  }

  const guard = CONTACT_SCOPED_TABLES.has(table)
    ? sql` AND NOT (${contactScopedTwinExists(table, sql`${contactId}::uuid`)})`
    : sql.empty();

  for (;;) {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE ${name} SET contact_id = ${contactId}::uuid
       WHERE id IN (
         SELECT t.id FROM ${name} t
          WHERE t.user_id = ${key} AND t.contact_id IS NULL${guard}
          LIMIT ${rowsPerStatement}
       )
      RETURNING id
    `);
    statements += 1;
    if (rows.length === 0) return { updated, statements, folded };
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
  let preferencesFolded = 0;

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
          preferencesFolded += filled.folded;
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
          preferencesFolded += filled.folded;
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
      preferencesFolded,
      statements,
    });
    return {
      status: "completed",
      contactsScanned,
      canonical,
      alias,
      updated,
      ambiguousAliases,
      preferencesFolded,
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
      preferencesFolded,
      statements,
      reason: message,
    };
  }
}

// ---------------------------------------------------------------------------
// T6 — the invariant probe
// ---------------------------------------------------------------------------

/** One table's verdict. `missing` and `mismatched` are failures; `orphaned`
 * (D5) and `duplicates` (PRD 05 T3) are information and may be non-zero. */
export interface ContactIdVerifyCounts {
  /** A live contact owns the row's `user_id` — canonically OR by alias — but
   * `contact_id` is NULL and the stamp WOULD land. After a completed sweep this
   * is a HOLE: either the backfill missed the row or a dual-write site dropped
   * it (D6). MUST be 0. */
  missing: number;
  /**
   * PRD 05 T3 — a live contact owns the row's `user_id`, `contact_id` is NULL,
   * and stamping it would violate one of the contact-scoped partial unique
   * indexes because the contact ALREADY holds a row for that live journey / live
   * bucket / address. The sweep skips these on purpose (cancelling someone's
   * live enrollment is not a background job's call), so counting them as
   * `missing` would pin the gate shut forever on a population no sweep can
   * drain. Reported separately so operators can triage it; NOT part of the gate.
   */
  duplicates: number;
  /** `contact_id` points at a contact that owns the row's `user_id` NEITHER
   * canonically NOR by alias (including a pointer at no contact at all). The
   * corruption detector, and the one count an FK could never give: an FK proves
   * the uuid EXISTS, this proves it is the RIGHT uuid. MUST be 0. */
  mismatched: number;
  /** `contact_id` is NULL and NO live contact owns the key either way — a
   * refused anonymous ingest, a keyless raw send. Expected, permitted, reported.
   * NEVER a failure (D5). */
  orphaned: number;
}

/** The probe's verdict for the whole database (or, when scoped, for the keys it
 * was pointed at). */
export interface ContactIdVerifyResult {
  tables: Record<ContactIdBackfillTable, ContactIdVerifyCounts>;
  /** The five tables summed — what the alert line and the gate read. */
  totals: ContactIdVerifyCounts;
  /**
   * **THE PRD 05 ENTRY GATE.** True iff EVERY table reports `missing === 0` AND
   * `mismatched === 0` — i.e. every row a live contact owns is stamped, and
   * every stamp points at a contact that really owns that row's key. `orphaned`
   * and `duplicates` are deliberately NOT part of the gate (D5 makes the first
   * legitimately non-zero forever; the second is a population the sweep skips on
   * purpose — see {@link ContactIdVerifyCounts.duplicates} — so gating on it
   * would shut the door on a number no sweep can drain). PRD 05 flips reads from `user_id` onto `contact_id`; flipping
   * while this is false means silently losing history (`missing`) or attributing
   * it to the wrong person (`mismatched`). Judge it AFTER a completed sweep — a
   * false reading with no sweep on record is just a pending backfill.
   */
  flipReady: boolean;
}

/**
 * "Contact `c` owns key `k`" — the **ALIAS-AWARE** ownership definition
 * (T6's "T4 review correction", LOCKED):
 *
 *   `coalesce(c.external_id, c.anonymous_id, c.id::text) = k`   (canonical)
 *   **OR** a live alias row `(contact_id = c.id, alias_value = k,
 *   alias_kind IN ('external','anonymous'))`                     (alias)
 *
 * The bare canonical coalesce is WRONG post-PRD-03 and is not a nicety: a
 * second-device anonymous id lives ONLY in `contact_aliases`, the dual-write
 * deliberately resolves it (C1), and a coalesce-only `mismatched` probe would
 * flag every such CORRECTLY-stamped row as corruption — a false alarm that would
 * block the gate forever on any deployment where anyone has ever used two
 * devices. Kinds are restricted to `external`/`anonymous` for the same reason
 * pass 2 restricts them (D4): those are the only kinds a canonical key can ever
 * be, so an `email`/`discord` alias is NOT ownership.
 *
 * Three properties worth naming:
 *
 *  - `missing`, `duplicates` and `orphaned` PARTITION the NULL-stamped rows:
 *    every row with `contact_id IS NULL` is exactly one of the three, so
 *    `missing + duplicates + orphaned = count(*) WHERE contact_id IS NULL` —
 *    which is what makes "zero NULLs" the wrong completion criterion and this
 *    the right one. `duplicates` (PRD 05 T3) splits off the owned rows the sweep
 *    deliberately leaves NULL because stamping them would violate a
 *    contact-scoped unique index.
 *  - `mismatched` does NOT require the pointed-at contact to be LIVE. A
 *    soft-deleted contact whose key still matches is consistent data (someone
 *    was deleted), not corruption; demanding liveness would fail the gate on
 *    every GDPR delete. The merge-regression case risk 5 worries about is still
 *    caught, because a merge REWRITES the row's `user_id` to the survivor's key
 *    — so a row stranded on a soft-deleted loser mismatches on the KEY. A
 *    pointer at a contact row that does not exist at all is counted (that is the
 *    FK's job, and this probe is meant to be strictly stronger than an FK).
 *  - **`user_id IS NULL` rows are NOT counted as mismatched, and the reasoning
 *    is load-bearing.** D7 makes a raw/keyless send stamp `contact_id = NULL`
 *    (`lib/tracked.ts` resolves `sendContactId` only `if (options.userId)`), so
 *    the instinct — "a keyless row carrying a `contact_id` must be a new writer
 *    violating D7" — looks safe. It is FALSE: the admin resend path
 *    (`routes/admin/bulk.ts`, D8 row 11) inserts its new `email_sends` row with
 *    `contactId: email.contactId` copied off the source row and does NOT copy
 *    `userId` (the pre-existing gap T4d files as do-not-fix). So
 *    `user_id IS NULL AND contact_id IS NOT NULL` is reachable TODAY, on a
 *    committed path, carrying a CORRECT contact_id. Counting it would pin
 *    `mismatched > 0` on any deployment that has ever resent a bounced email —
 *    the same permanent false alarm the alias correction exists to prevent. The
 *    cost, stated plainly: a future writer resolving a keyless send by recipient
 *    ADDRESS would be indistinguishable from a resend, so this probe cannot
 *    catch that particular D7 violation. `email_sends` is the only one of the
 *    five tables where the case exists at all — the other four are
 *    `user_id NOT NULL`.
 *
 * Two set-based statements per table, no per-row work: one over the NULL-stamped
 * rows (which `missing`/`orphaned` partition) and one over the stamped rows
 * (whose `contact_id IS NOT NULL` predicate is exactly D2's partial index). The
 * canonical leg is the same `contactKeySql()` coalesce the backfill keys on; the
 * alias leg probes `contact_aliases_kind_value_idx` (an `IN` on the leading
 * `alias_kind` column keeps the index usable).
 */
async function verifyTable(
  db: Database,
  table: ContactIdBackfillTable,
  userIds: string[] | undefined,
): Promise<ContactIdVerifyCounts> {
  const name = sql.identifier(table);
  const scope = scopeToKeys(userIds);

  // PRD 05 T3 — the owner is now RESOLVED (a LATERAL) rather than merely
  // asserted (two EXISTS), because `duplicates` needs the owner's id to ask
  // whether that contact already holds the row this stamp would duplicate. Same
  // ownership definition, same two legs, same cost profile (the canonical leg is
  // a `coalesce(...)` comparison either way, so neither shape is index-driven).
  const collides = CONTACT_SCOPED_TABLES.has(table)
    ? contactScopedTwinExists(table, sql`owner.id`)
    : sql`false`;

  const [nulls] = await db.execute<{
    missing: number;
    duplicates: number;
    orphaned: number;
  }>(sql`
    SELECT count(*) FILTER (WHERE s.owner IS NOT NULL AND NOT s.collides)::int
             AS missing,
           count(*) FILTER (WHERE s.owner IS NOT NULL AND s.collides)::int
             AS duplicates,
           count(*) FILTER (WHERE s.owner IS NULL)::int
             AS orphaned
      FROM (
        SELECT owner.id AS owner, (${collides}) AS collides
          FROM ${name} t
          LEFT JOIN LATERAL (
            SELECT contacts.id
              FROM contacts
             WHERE contacts.deleted_at IS NULL
               AND (
                 ${contactKeySql()} = t.user_id
                 OR EXISTS (
                   SELECT 1 FROM contact_aliases a
                    WHERE a.contact_id = contacts.id
                      AND a.alias_value = t.user_id
                      AND a.alias_kind IN ('external', 'anonymous')
                 )
               )
             LIMIT 1
          ) owner ON true
         WHERE t.contact_id IS NULL${scope}
      ) s
  `);

  const [stamped] = await db.execute<{ mismatched: number }>(sql`
    SELECT count(*)::int AS mismatched
      FROM ${name} t
      LEFT JOIN contacts ON contacts.id = t.contact_id
     WHERE t.contact_id IS NOT NULL
       AND t.user_id IS NOT NULL${scope}
       AND ${contactKeySql()} IS DISTINCT FROM t.user_id
       AND NOT EXISTS (
             SELECT 1 FROM contact_aliases a
              WHERE a.contact_id = contacts.id
                AND a.alias_value = t.user_id
                AND a.alias_kind IN ('external', 'anonymous')
           )
  `);

  return {
    missing: Number(nulls?.missing ?? 0),
    duplicates: Number(nulls?.duplicates ?? 0),
    mismatched: Number(stamped?.mismatched ?? 0),
    orphaned: Number(nulls?.orphaned ?? 0),
  };
}

/** The optional key restriction, appended to both statements' WHERE. `undefined`
 * = the whole table (the gate); an EMPTY list means "these zero keys", which is
 * `false`, not "everything". */
function scopeToKeys(userIds: string[] | undefined) {
  if (userIds === undefined) return sql.empty();
  if (userIds.length === 0) return sql` AND false`;
  return sql` AND t.user_id IN (${sql.join(
    userIds.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/**
 * PRD 04 T6 — the invariant probe, and the thing this PRD ships INSTEAD of a
 * foreign key (D1): an FK proves the uuid exists, this proves it is the right
 * uuid. It is also the only control that can catch a dual-write writing the
 * WRONG contact (risk 3) — the backfill cannot, because it only fills NULLs and
 * will happily leave a wrong non-NULL value in place. **The backfill is not a
 * repair tool**; if `mismatched > 0` the fix is a targeted corrective job.
 *
 * Read-only. Five tables × two set-based statements, run SEQUENTIALLY rather
 * than fanned out: these are full-table probes by nature, and five concurrent
 * scans of the two largest tables in the system is not what an operator wants
 * from an on-demand admin endpoint. Nothing here is on a hot path.
 *
 * `userIds` restricts every count to rows carrying one of those exact `user_id`
 * values. **The gate is the UNSCOPED call** — that is what the admin route runs
 * and what `flipReady` means. The scope exists so a caller can ask the question
 * about a known set of keys; in practice that caller is the test suite, which
 * shares one Postgres with concurrently-running files and would otherwise be
 * reduced to asserting deltas on counts other writers move underneath it.
 */
export async function verifyContactIdBackfill(opts: {
  db: Database;
  userIds?: string[];
}): Promise<ContactIdVerifyResult> {
  const tables = {} as Record<ContactIdBackfillTable, ContactIdVerifyCounts>;
  const totals: ContactIdVerifyCounts = {
    missing: 0,
    duplicates: 0,
    mismatched: 0,
    orphaned: 0,
  };

  for (const table of TABLES) {
    const counts = await verifyTable(opts.db, table, opts.userIds);
    tables[table] = counts;
    totals.missing += counts.missing;
    totals.duplicates += counts.duplicates;
    totals.mismatched += counts.mismatched;
    totals.orphaned += counts.orphaned;
  }

  return {
    tables,
    totals,
    flipReady: totals.missing === 0 && totals.mismatched === 0,
  };
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
