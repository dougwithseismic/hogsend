# Reference: the idempotent batched backfill

When a release adds a column that needs populating on existing rows, **do not**
put the data change inside a schema migration — that holds locks and runs
unbounded against a live database. Instead, drive it from a Hatchet task using
`runBatchedBackfill` (from `@hogsend/engine`), which runs the migration in small,
idempotent, lock-friendly batches that are **resumable**: if the process dies,
re-running continues from where it left off because each batch only selects rows
that still need work.

The scaffold ships a ready-to-customize template at
`src/workflows/backfill-example.ts`.

## Expand → migrate → contract

Sequence the change across releases so old and new code can run side by side:

1. **Release N (expand)** — the migration adds the column (nullable / defaulted);
   code writes BOTH the old and new shape. Deploy.
2. **Run the backfill task once** (Hatchet dashboard, or push its event) to
   populate existing rows. It's batched, idempotent and resumable.
3. **Release N+1** — code reads the new column.
4. **Release N+2 (contract)** — once the backfill is confirmed complete, a
   migration drops the old column / adds `NOT NULL`.

## `runBatchedBackfill` — the driver

```ts
interface BatchedBackfillOptions {
  db: Database;
  logger: { info: (m: string) => unknown; warn: (m: string) => unknown };
  label: string;            // human label for logs, e.g. "contacts.normalized_email"
  runBatch: (db: Database, batchSize: number) => Promise<number>; // rows affected; 0 = done
  batchSize?: number;       // default 500
  pauseMs?: number;         // default 0 — pause between batches to relieve a live DB
  maxBatches?: number;      // default 100_000 — safety cap, logs + stops (not an error)
}

interface BatchedBackfillResult {
  batches: number;
  rows: number;
  exhausted: boolean;       // true only when a batch returned 0 (ran to completion)
}
```

The two rules that make it safe:

- **`runBatch` MUST be idempotent and self-bounding.** It should touch only rows
  that still need the change (e.g. `WHERE new_col IS NULL ... LIMIT n`) and return
  the number of rows affected. Return `0` when nothing is left — that's the signal
  to stop (`exhausted: true`).
- **Lock-friendly batches.** Select the batch with `FOR UPDATE SKIP LOCKED` so
  concurrent runs/workers don't fight over the same rows, and keep `batchSize`
  small so each statement holds locks only briefly.

## The template task

`src/workflows/backfill-example.ts` — assumes a release just added
`contacts.normalized_email`. Change the table/columns to match your migration:

```ts
import { createDatabase } from "@hogsend/db";
import { createLogger, hatchet, runBatchedBackfill } from "@hogsend/engine";
import { sql } from "drizzle-orm";

export const backfillExampleTask = hatchet.task({
  name: "backfill-example",
  retries: 2,
  executionTimeout: "30m",
  fn: async () => {
    const { db, client } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
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
```

Anatomy of the batch SQL above:

- The `batch` CTE selects up to `limit` rows that **still need work**
  (`WHERE normalized_email IS NULL`) and locks them with `FOR UPDATE SKIP LOCKED`.
- The `UPDATE ... FROM batch` writes only those locked rows and `RETURNING c.id`
  gives a row count — `updated.length` is what `runBatch` returns.
- Because the predicate excludes already-migrated rows, a re-run after a crash
  resumes cleanly, and two workers never collide.

## Enabling it

The example is **already wired** via `extraWorkflows` in `src/workflows/index.ts`:

```ts
import { backfillExampleTask } from "./backfill-example.js";

export const extraWorkflows = [backfillExampleTask];
```

which `src/worker.ts` passes as `createWorker({ container, journeys, buckets,
extraWorkflows })`. (Remove `backfillExampleTask` and the file if you don't need
it.) For the general task-registration mechanics see
`references/custom-workflow.md`. Trigger the run once from the Hatchet dashboard
(or by pushing its event); re-running is safe and resumes where it left off.

## Adapting it — checklist

1. Copy `backfill-example.ts` (or edit it) to target your new table/column.
2. Make `runBatch`'s predicate exclude already-done rows (`WHERE new_col IS NULL`)
   and lock with `FOR UPDATE SKIP LOCKED`.
3. Keep `batchSize` modest; set `pauseMs` to relieve a live database.
4. Return the plain `{ batches, rows, exhausted }` summary (JSON-serializable).
5. Ensure the task is listed in `extraWorkflows`, restart the worker, run it once.
6. Only after `exhausted: true` is confirmed, ship the contract migration
   (`NOT NULL` / drop old column).
