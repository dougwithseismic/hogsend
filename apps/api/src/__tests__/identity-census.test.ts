import { randomUUID } from "node:crypto";
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

// Resolved from this file, not from cwd: src/__tests__ → src → api → apps →
// repo root.
const CENSUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/identity-census.sql",
);

const CENSUS_SQL = readFileSync(CENSUS_PATH, "utf8");

// Every (table_name, metric) label the script must report, in script order.
const HISTORY_TABLES = [
  "user_events",
  "journey_states",
  "bucket_memberships",
  "email_sends",
  "email_preferences",
] as const;
const HISTORY_METRICS = [
  "total",
  "null_contact_id",
  "null_no_user_id",
  "null_live_key",
  "null_aliased_key",
] as const;
const PARITY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["contact_aliases", "kind_external"],
  ["contacts", "col_external"],
  ["contacts", "external_unaliased"],
  ["contact_aliases", "kind_anonymous"],
  ["contacts", "col_anonymous"],
  ["contacts", "anonymous_unaliased"],
  ["contact_aliases", "kind_email"],
  ["contacts", "col_email"],
  ["contacts", "email_unaliased"],
  ["contact_aliases", "kind_discord"],
  ["contacts", "col_discord"],
  ["contacts", "discord_unaliased"],
  ["contacts", "anon_only"],
];

type CensusRow = { table_name: string; metric: string; count: string };
type Census = Map<string, bigint>;

const key = (table: string, metric: string) => `${table}:${metric}`;

let client: ReturnType<typeof createDatabase>["client"];
let db: ReturnType<typeof createDatabase>["db"];

beforeAll(() => {
  const created = createDatabase({ url: process.env.DATABASE_URL as string });
  client = created.client;
  db = created.db;
});

afterAll(async () => {
  await client?.end();
});

async function runCensus(executor: {
  execute: (q: ReturnType<typeof sql.raw>) => Promise<unknown>;
}): Promise<Census> {
  const result = (await executor.execute(sql.raw(CENSUS_SQL))) as unknown as {
    rows: CensusRow[];
  };
  const rows = Array.isArray(result) ? (result as CensusRow[]) : result.rows;
  return new Map(
    rows.map((r) => [key(r.table_name, r.metric), BigInt(r.count)]),
  );
}

/** Sentinel that unwinds the fixture transaction so the shared DB stays clean. */
class Rollback extends Error {}

describe("identity census script (PRD 07 T1)", () => {
  it("parses, reports every label, and counts the fixture shapes exactly", async () => {
    const run = `census_${randomUUID().slice(0, 8)}`;
    let baseline: Census | undefined;
    let after: Census | undefined;

    // REPEATABLE READ pins the snapshot at the first read, so the two census
    // passes see the same committed world and the fixture deltas are EXACT —
    // per repo law, whole-database counters are otherwise unassertable in the
    // shared suite. The throw at the end rolls everything back; the sweep and
    // other files never see these rows.
    await db
      .transaction(
        async (tx) => {
          baseline = await runCensus(tx);

          const c1 = randomUUID();
          const c2 = randomUUID();
          const c3 = randomUUID();
          await tx.execute(sql`
            insert into contacts (id, external_id) values
              (${c1}, ${`${run}_ext`}),
              (${c2}, ${`${run}_ext2`});
          `);
          await tx.execute(sql`
            insert into contacts (id, anonymous_id) values
              (${c3}, ${`${run}_anon3`});
          `);
          // C1's canonical key is aliased; it also holds a claimed anonymous
          // alias whose value is NOT its canonical key. C2 is deliberately
          // unaliased (parity metric). C3 is the anon-only population.
          await tx.execute(sql`
            insert into contact_aliases
              (contact_id, alias_kind, alias_value, reason) values
              (${c1}, 'external', ${`${run}_ext`}, 'promote'),
              (${c1}, 'anonymous', ${`${run}_anonalias`}, 'promote');
          `);
          // Two contactless rows: one under C1's canonical key (an adoption
          // gap → null_live_key AND null_aliased_key), one under C1's
          // non-canonical anonymous alias (null_aliased_key ONLY — this is
          // what separates the two metrics).
          await tx.execute(sql`
            insert into user_events (user_id, event) values
              (${`${run}_ext`}, 'census.probe'),
              (${`${run}_anonalias`}, 'census.probe');
          `);

          after = await runCensus(tx);
          throw new Rollback();
        },
        { isolationLevel: "repeatable read" },
      )
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });

    if (!baseline || !after) throw new Error("census did not run");

    // Shape: every label present, exactly once, on both passes.
    const expected = [
      ...HISTORY_TABLES.flatMap((t) => HISTORY_METRICS.map((m) => key(t, m))),
      ...PARITY_LABELS.map(([t, m]) => key(t, m)),
    ];
    expect([...after.keys()].sort()).toEqual([...expected].sort());
    expect(after.size).toBe(expected.length);

    const delta = (table: string, metric: string) => {
      const k = key(table, metric);
      const before = baseline?.get(k);
      const now = after?.get(k);
      if (before === undefined || now === undefined) {
        throw new Error(`census label missing: ${k}`);
      }
      return now - before;
    };

    // Exact deltas from the fixtures above.
    expect(delta("user_events", "total")).toBe(2n);
    expect(delta("user_events", "null_contact_id")).toBe(2n);
    expect(delta("user_events", "null_no_user_id")).toBe(0n);
    expect(delta("user_events", "null_live_key")).toBe(1n);
    expect(delta("user_events", "null_aliased_key")).toBe(2n);
    expect(delta("contacts", "col_external")).toBe(2n);
    expect(delta("contacts", "external_unaliased")).toBe(1n);
    expect(delta("contact_aliases", "kind_external")).toBe(1n);
    expect(delta("contact_aliases", "kind_anonymous")).toBe(1n);
    expect(delta("contacts", "col_anonymous")).toBe(1n);
    expect(delta("contacts", "anonymous_unaliased")).toBe(1n);
    expect(delta("contacts", "anon_only")).toBe(1n);
    // The other history tables gained nothing.
    expect(delta("journey_states", "null_contact_id")).toBe(0n);
    expect(delta("email_sends", "null_contact_id")).toBe(0n);
  }, 30_000);
});
