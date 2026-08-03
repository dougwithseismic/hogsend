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

// The five history tables that carry a person's past. Each gains a nullable
// `contact_id uuid` the engine dual-writes (PRD 04); nothing reads it yet.
const HISTORY_TABLES = [
  "user_events",
  "journey_states",
  "bucket_memberships",
  "email_sends",
  "email_preferences",
] as const;

let client: ReturnType<typeof createDatabase>["client"];
let db: ReturnType<typeof createDatabase>["db"];

// Read-only against schema metadata — no fixtures written, so no cleanup.
let columns: Array<{
  table_name: string;
  data_type: string;
  is_nullable: string;
}>;

beforeAll(async () => {
  const created = createDatabase({ url: process.env.DATABASE_URL as string });
  client = created.client;
  db = created.db;

  const rows = await db.execute(sql`
    SELECT table_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'contact_id'
      AND table_name IN (
        'user_events',
        'journey_states',
        'bucket_memberships',
        'email_sends',
        'email_preferences'
      )
  `);
  columns = rows as unknown as typeof columns;
});

afterAll(async () => {
  await client?.end();
});

describe("history tables carry contact_id (PRD 04 T1)", () => {
  for (const table of HISTORY_TABLES) {
    it(`${table} has a nullable contact_id uuid column`, () => {
      const column = columns.find((c) => c.table_name === table);

      expect(column, `${table}.contact_id is missing`).toBeDefined();
      expect(column?.data_type).toBe("uuid");
      expect(column?.is_nullable).toBe("YES");
    });
  }

  it("covers exactly the five history tables", () => {
    expect(columns.map((c) => c.table_name).sort()).toEqual(
      [...HISTORY_TABLES].sort(),
    );
  });
});
