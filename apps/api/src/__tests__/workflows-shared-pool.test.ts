/**
 * Workflow tasks share the process `getDb()` pool.
 *
 * A task that calls `createDatabase()` in its `fn` opens a fresh postgres.js
 * pool (max 10) on every run and never ends it, so cohorts of runs that wake
 * together churn connections toward `max_connections`. `bucketExpiryTask` did
 * it before a durable sleep, re-opening on every replay.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/engine/src/workflows",
);

it("no engine workflow opens its own database pool", () => {
  const offenders = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) =>
      readFileSync(join(WORKFLOWS, f), "utf8").includes("createDatabase("),
    );
  expect(offenders).toEqual([]);
});
