import type { Database } from "@hogsend/db";

interface BackfillLogger {
  info: (message: string) => unknown;
  warn: (message: string) => unknown;
}

export interface BatchedBackfillOptions {
  db: Database;
  logger: BackfillLogger;
  /** Human label for logs, e.g. `contacts.normalized_email`. */
  label: string;
  /**
   * Run one batch. MUST be idempotent and self-bounding — it should only touch
   * rows that still need the change (e.g. `WHERE new_col IS NULL ... LIMIT n`)
   * and return the number of rows affected. Return 0 when nothing is left.
   */
  runBatch: (db: Database, batchSize: number) => Promise<number>;
  /** Rows per batch. Small enough that each statement holds locks briefly. */
  batchSize?: number;
  /** Pause between batches (ms) to relieve pressure on a live database. */
  pauseMs?: number;
  /** Safety cap on total batches; logs and stops rather than looping forever. */
  maxBatches?: number;
}

export interface BatchedBackfillResult {
  batches: number;
  rows: number;
  /** True if the backfill ran to completion (a batch returned 0). */
  exhausted: boolean;
}

/**
 * Run a long data migration in small, idempotent, lock-friendly batches.
 *
 * This is the supported home for bulk data changes — they must NOT live inside
 * a schema migration, which would hold locks and run unbounded against a live
 * database. Drive it from a Hatchet task so it's resumable and observable; if
 * the process dies, re-running continues from where it left off because each
 * batch only selects rows that still need work. See docs/UPGRADING.md.
 */
export async function runBatchedBackfill(
  opts: BatchedBackfillOptions,
): Promise<BatchedBackfillResult> {
  const {
    db,
    logger,
    label,
    runBatch,
    batchSize = 500,
    pauseMs = 0,
    maxBatches = 100_000,
  } = opts;

  let batches = 0;
  let rows = 0;
  logger.info(`[backfill:${label}] starting (batchSize=${batchSize})`);

  while (batches < maxBatches) {
    const affected = await runBatch(db, batchSize);
    if (affected === 0) {
      logger.info(
        `[backfill:${label}] complete — ${rows} row(s) across ${batches} batch(es)`,
      );
      return { batches, rows, exhausted: true };
    }
    batches += 1;
    rows += affected;
    if (batches % 20 === 0) {
      logger.info(
        `[backfill:${label}] progress — ${rows} row(s) across ${batches} batch(es)`,
      );
    }
    if (pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  logger.warn(
    `[backfill:${label}] reached maxBatches=${maxBatches} — stopping. Re-run to continue.`,
  );
  return { batches, rows, exhausted: false };
}
