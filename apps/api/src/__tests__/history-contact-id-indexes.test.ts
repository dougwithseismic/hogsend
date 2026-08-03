import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@hogsend/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The five partial btree indexes added by migration 0070 (PRD 04 T2), one per
// history table, each scoped to `WHERE contact_id IS NOT NULL`.
const CONTACT_ID_INDEXES = [
  "user_events_contact_id_idx",
  "journey_states_contact_id_idx",
  "bucket_memberships_contact_id_idx",
  "email_sends_contact_id_idx",
  "email_preferences_contact_id_idx",
] as const;

// Postgres normalizes the predicate it stores, so this is the exact substring
// `pg_indexes.indexdef` renders for `WHERE contact_id IS NOT NULL` — the
// parenthesized form, not the source form.
const PREDICATE = "WHERE (contact_id IS NOT NULL)";

// The migration ships its statements as `CREATE INDEX IF NOT EXISTS` (hand-
// edited over drizzle's plain `CREATE INDEX`) so an operator who pre-created
// the indexes CONCURRENTLY against the previous release gets a no-op here.
const REQUIRED_PREFIX = "CREATE INDEX IF NOT EXISTS";

// Resolved from this file, not from cwd, so the test is invocable from any
// working directory: src/__tests__ → src → api → apps → repo root.
const MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/drizzle/0070_confused_mindworm.sql",
);

/**
 * The migration body split back into executable statements: drop drizzle's
 * `--> statement-breakpoint` markers, strip SQL line comments (the hand-edit
 * carries an explanatory header), and discard anything left empty.
 */
const MIGRATION_STATEMENTS = readFileSync(MIGRATION_PATH, "utf8")
  .split("--> statement-breakpoint")
  .map((chunk) =>
    chunk
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((statement) => statement.length > 0);

const PROBE_UUID = "00000000-0000-0000-0000-000000000000";

let client: ReturnType<typeof createDatabase>["client"];
let db: ReturnType<typeof createDatabase>["db"];

let indexes: Array<{ indexname: string; indexdef: string }>;

beforeAll(async () => {
  const created = createDatabase({ url: process.env.DATABASE_URL as string });
  client = created.client;
  db = created.db;

  const rows = await db.execute(sql`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'user_events_contact_id_idx',
        'journey_states_contact_id_idx',
        'bucket_memberships_contact_id_idx',
        'email_sends_contact_id_idx',
        'email_preferences_contact_id_idx'
      )
  `);
  indexes = rows as unknown as typeof indexes;
});

afterAll(async () => {
  await client?.end();
});

describe("history tables carry a partial contact_id index (PRD 04 T2)", () => {
  for (const name of CONTACT_ID_INDEXES) {
    it(`${name} exists and is partial on contact_id IS NOT NULL`, () => {
      const index = indexes.find((i) => i.indexname === name);

      expect(index, `${name} is missing`).toBeDefined();
      expect(index?.indexdef).toContain(PREDICATE);
      expect(index?.indexdef).toContain("USING btree (contact_id)");
    });
  }

  it("covers exactly the five history indexes", () => {
    expect(indexes.map((i) => i.indexname).sort()).toEqual(
      [...CONTACT_ID_INDEXES].sort(),
    );
  });

  // THE IMPORTANT ONE. D2 chose a PARTIAL index on the argument that the
  // planner can prove `contact_id = $1` implies `contact_id IS NOT NULL`, so
  // the predicate is not a barrier to the merge repoint's equality probes.
  // That is the one assumption in D2 that would be expensive to discover was
  // wrong, so it is asserted rather than believed. `enable_seqscan = off` only
  // penalizes a sequential scan (it cannot forbid one), so on an empty table
  // the planner still falls back to Seq Scan if the index is unusable here —
  // which makes this a real test, not a rigged one.
  it("the planner uses the partial index for a contact_id equality probe", async () => {
    const plan = await db.transaction(async (tx) => {
      // SET LOCAL keeps this on ONE session (the transaction's connection) and
      // unwinds at COMMIT, so nothing leaks back into the pool.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);

      const rows = (await tx.execute(
        sql`EXPLAIN SELECT id FROM user_events WHERE contact_id = '${sql.raw(PROBE_UUID)}'`,
      )) as unknown as Array<Record<string, string>>;

      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("user_events_contact_id_idx");
    expect(plan).toMatch(/Index Scan|Index Only Scan|Bitmap Index Scan/);
    // No recheck of the predicate anywhere in the plan: the planner discharged
    // it at plan time, which is the whole claim.
    expect(plan).not.toContain("contact_id IS NOT NULL");

    // The session setting is back to its default outside the transaction.
    const after = (await db.execute(
      sql`SHOW enable_seqscan`,
    )) as unknown as Array<{ enable_seqscan: string }>;
    expect(after[0]?.enable_seqscan).toBe("on");
  });

  // The indexes and the columns ship in SEPARATE releases so an operator can
  // pre-create these CONCURRENTLY against the previous release. That only works
  // if re-running the migration over existing indexes is a no-op.
  describe("the migration is idempotent (the IF NOT EXISTS path)", () => {
    it("parses to exactly the five index statements", () => {
      expect(MIGRATION_STATEMENTS).toHaveLength(CONTACT_ID_INDEXES.length);
    });

    for (const name of CONTACT_ID_INDEXES) {
      it(`creates ${name} with IF NOT EXISTS`, () => {
        const statement = MIGRATION_STATEMENTS.find((s) => s.includes(name));

        expect(statement, `no statement creates ${name}`).toBeDefined();
        expect(statement?.startsWith(REQUIRED_PREFIX)).toBe(true);
      });
    }

    it("every statement is guarded", () => {
      for (const statement of MIGRATION_STATEMENTS) {
        expect(statement.startsWith(REQUIRED_PREFIX)).toBe(true);
      }
    });

    // NOTE this test WRITES: executing the guarded statements recreates any
    // index that is missing, so a broken migration shows up on the FIRST run
    // against a fresh DB (CI's shape), not on re-runs against a persistent one.
    // The file-content assertions above are what pin the migration itself.
    it("re-running every statement against the live DB does not throw", async () => {
      for (const statement of MIGRATION_STATEMENTS) {
        await expect(db.execute(sql.raw(statement))).resolves.toBeDefined();
      }
    });
  });
});
