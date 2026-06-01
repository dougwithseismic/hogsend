import { createDatabase } from "@hogsend/db";
import { createLogger, hatchet, runBatchedBackfill } from "@hogsend/engine";
import { sql } from "drizzle-orm";

/**
 * TEMPLATE — not registered by default. Copy this when a release adds a column
 * that needs populating on existing rows.
 *
 * Follow the expand → migrate → contract sequence from docs/UPGRADING.md:
 *   1. Release N: migration adds the column (nullable / defaulted); code writes
 *      both old and new. Deploy.
 *   2. Run THIS job once (Hatchet dashboard, or `hatchet.events.push`) to
 *      backfill existing rows. It's batched, idempotent and resumable.
 *   3. Release N+1: code reads the new column. Release N+2: migration drops the
 *      old column / adds NOT NULL once the backfill is confirmed complete.
 *
 * To enable: add `backfillExampleTask` to the `workflows` array in
 * src/worker.ts. The example below assumes a `contacts.normalized_email` column
 * was just added — change the table/columns to match your migration.
 */
export const backfillExampleTask = hatchet.task({
  name: "backfill-example",
  retries: 2,
  executionTimeout: "30m",
  fn: async () => {
    const { db, client } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    try {
      const result = await runBatchedBackfill({
        db,
        logger,
        label: "contacts.normalized_email",
        batchSize: 500,
        pauseMs: 50,
        runBatch: async (database, limit) => {
          // Bounded, idempotent batch: only rows that still need it, locked with
          // SKIP LOCKED so concurrent runs/workers don't fight over the same rows.
          const updated = (await database.execute(sql`
            WITH batch AS (
              SELECT id FROM contacts
              WHERE normalized_email IS NULL
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE contacts c
            SET normalized_email = lower(trim(c.email))
            FROM batch
            WHERE c.id = batch.id
            RETURNING c.id
          `)) as unknown as unknown[];
          return updated.length;
        },
      });
      // Return a plain JSON object so Hatchet can serialize the task output.
      return {
        batches: result.batches,
        rows: result.rows,
        exhausted: result.exhausted,
      };
    } finally {
      await client.end({ timeout: 5 });
    }
  },
});
