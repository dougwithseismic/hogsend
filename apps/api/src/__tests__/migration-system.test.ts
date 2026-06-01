import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLIENT_MIGRATIONS_TABLE,
  createDatabase,
  ENGINE_MIGRATIONS_TABLE,
  getBundledMigrations,
  getClientSchemaVersion,
  getEngineSchemaVersion,
  getSchemaVersion,
  type JournalShape,
  type SchemaVersion,
} from "@hogsend/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point the app/container (used by the health-endpoint test) at the real,
// migrated dev DB — matches how the other integration tests in this suite work.
// This must run before `@hogsend/engine` (and its env validation) is imported,
// so the engine is pulled in dynamically inside the health-endpoint test below.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const PG_SERVER = "postgresql://growthhog:growthhog@localhost:5434";
const ADMIN_URL = `${PG_SERVER}/growthhog`;
const TEST_DB = "hogsend_migrate_test";
const TEST_URL = `${PG_SERVER}/${TEST_DB}`;
const REPO_ROOT = resolve(process.cwd(), "../..");

let testClient: ReturnType<typeof createDatabase>["client"];
let testDb: ReturnType<typeof createDatabase>["db"];

// The synthetic client-track fixture (a trivially additive migration creating a
// `client_demo` table) doubles as the canonical sample client track for CI.
const CLIENT_FIXTURE_DIR = resolve(
  process.cwd(),
  "src/__tests__/fixtures/client-migrations",
);
const clientJournal = JSON.parse(
  readFileSync(resolve(CLIENT_FIXTURE_DIR, "meta/_journal.json"), "utf8"),
) as JournalShape;

// Run the REAL migrator binary against a database, capturing its output so we
// can assert on its logging (apply count, idempotency messages).
function runMigrator(databaseUrl: string): string {
  return execSync("pnpm --filter @hogsend/db db:migrate 2>&1", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

// Run the REAL client migrator binary (mirrors `runMigrator`) — shells the same
// `db:migrate:client` script CI and railway use, pointed at a fixture folder.
function runClientMigrator(databaseUrl: string, folder: string): string {
  return execSync("pnpm --filter @hogsend/db db:migrate:client 2>&1", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      CLIENT_MIGRATIONS_FOLDER: folder,
    },
  });
}

beforeAll(async () => {
  const { client: admin } = createDatabase({ url: ADMIN_URL });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const test = createDatabase({ url: TEST_URL });
  testClient = test.client;
  testDb = test.db;
}, 60_000);

afterAll(async () => {
  await testClient?.end();
  const { client: admin } = createDatabase({ url: ADMIN_URL });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
}, 60_000);

describe("bundled migration manifest", () => {
  it("reads migrations from the journal in order", () => {
    const bundled = getBundledMigrations();
    expect(bundled.length).toBeGreaterThan(0);
    const idxs = bundled.map((b) => b.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });
});

describe("migrator end-to-end against a throwaway database", () => {
  it("reports every migration pending on an empty database", async () => {
    const bundled = getBundledMigrations();
    const v = await getSchemaVersion(testDb);
    expect(v.inSync).toBe(false);
    expect(v.applied).toBeNull();
    expect(v.pending).toHaveLength(bundled.length);
    expect(v.required).toBe(bundled.at(-1)?.tag ?? null);
  });

  it("applies all migrations from empty and reports in sync", async () => {
    const out = runMigrator(TEST_URL);
    expect(out).toMatch(/Applying \d+ migration/);
    expect(out).toMatch(/Migrations complete/);

    const bundled = getBundledMigrations();
    const v = await getSchemaVersion(testDb);
    expect(v.inSync).toBe(true);
    expect(v.pending).toHaveLength(0);
    expect(v.applied).toBe(bundled.at(-1)?.tag ?? null);
    expect(v.applied).toBe(v.required);
  }, 60_000);

  it("is idempotent — re-running applies nothing", async () => {
    const out = runMigrator(TEST_URL);
    expect(out).toMatch(/already up to date/i);
    const v = await getSchemaVersion(testDb);
    expect(v.inSync).toBe(true);
  }, 60_000);

  it("detects a database that is behind the build (boot guard trips)", async () => {
    const bundled = getBundledMigrations();
    // Simulate a rollback / skipped deploy: DB missing the newest migration.
    await testDb.execute(sql`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE id = (
        SELECT id FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 1
      )
    `);

    const v = await getSchemaVersion(testDb);
    expect(v.inSync).toBe(false);
    expect(v.pending).toEqual([bundled.at(-1)?.tag]);
    expect(v.applied).toBe(bundled.at(-2)?.tag ?? null);
  });
});

describe("two-track migrations against a throwaway database", () => {
  // Sequenced (engine first, then client) since both tracks share one DB. The
  // previous block left the engine ledger one migration behind; the first test
  // here re-applies it, restoring engine sync before the client track runs.

  it("engine track applies first and is independent of the client ledger", async () => {
    // The previous block deleted the newest engine ledger row (a behind-build
    // simulation) but left its schema objects in place, so re-running the
    // migrator would fail on already-existing DDL. The engine track is purely
    // count-based, so restore sync by re-stamping the ledger row instead.
    const bundled = getBundledMigrations();
    const last = bundled.at(-1);
    await testDb.execute(sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      SELECT 'restored-' || ${last?.tag ?? ""}, ${last?.when ?? 0}
      WHERE (SELECT count(*) FROM drizzle.__drizzle_migrations) < ${bundled.length}
    `);

    const e = await getEngineSchemaVersion(testDb);
    expect(e.inSync).toBe(true);
    expect(e.applied).toBe(getBundledMigrations().at(-1)?.tag ?? null);

    // The client ledger does not exist yet ⇒ client track is behind.
    const c = await getClientSchemaVersion(testDb, clientJournal);
    expect(c.inSync).toBe(false);
    expect(c.applied).toBeNull();
    expect(c.pending).toEqual(["0000_client_init"]);

    const reg = (await testDb.execute(sql`
      SELECT
        to_regclass('drizzle.__drizzle_migrations') AS engine,
        to_regclass('drizzle.__client_migrations') AS client
    `)) as unknown as Array<{ engine: string | null; client: string | null }>;
    expect(reg[0]?.engine).not.toBeNull();
    expect(reg[0]?.client).toBeNull();
  }, 60_000);

  it("client track applies into its own ledger without touching the engine ledger", async () => {
    const beforeRows = (await testDb.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ count: number }>;
    const engineCountBefore = Number(beforeRows[0]?.count ?? 0);

    const out = runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);
    expect(out).toMatch(/\[client\] Applying \d+ migration/);
    expect(out).toMatch(/Migrations complete/);

    const c = await getClientSchemaVersion(testDb, clientJournal);
    expect(c.inSync).toBe(true);
    expect(c.applied).toBe("0000_client_init");
    expect(c.pending).toHaveLength(0);

    // Engine ledger UNCHANGED by the client migrate.
    const afterRows = (await testDb.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ count: number }>;
    expect(Number(afterRows[0]?.count ?? 0)).toBe(engineCountBefore);
    expect((await getEngineSchemaVersion(testDb)).inSync).toBe(true);

    // Client ledger + the demo table now exist.
    const reg = (await testDb.execute(sql`
      SELECT
        to_regclass('drizzle.__client_migrations') AS ledger,
        to_regclass('public.client_demo') AS demo
    `)) as unknown as Array<{ ledger: string | null; demo: string | null }>;
    expect(reg[0]?.ledger).not.toBeNull();
    expect(reg[0]?.demo).not.toBeNull();
  }, 60_000);

  it("each ledger lives at its own table (independence proof)", async () => {
    expect(ENGINE_MIGRATIONS_TABLE).not.toBe(CLIENT_MIGRATIONS_TABLE);

    const rows = (await testDb.execute(sql`
      SELECT
        (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS engine,
        (SELECT count(*)::int FROM drizzle.__client_migrations) AS client
    `)) as unknown as Array<{ engine: number; client: number }>;
    expect(Number(rows[0]?.engine)).toBe(getBundledMigrations().length);
    expect(Number(rows[0]?.client)).toBe(clientJournal.entries.length);
  });

  it("client track is idempotent — re-running applies nothing", async () => {
    const out = runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);
    expect(out).toMatch(/already up to date/i);
    expect((await getClientSchemaVersion(testDb, clientJournal)).inSync).toBe(
      true,
    );
  }, 60_000);

  it("engine track stays idempotent after the client track applied", async () => {
    const out = runMigrator(TEST_URL);
    expect(out).toMatch(/already up to date/i);
    expect((await getEngineSchemaVersion(testDb)).inSync).toBe(true);
  }, 60_000);

  it("client pending is detected per track, leaving the engine unaffected", async () => {
    // Simulate the client ledger being behind by removing its newest row.
    await testDb.execute(sql`
      DELETE FROM drizzle.__client_migrations
      WHERE id = (
        SELECT id FROM drizzle.__client_migrations
        ORDER BY created_at DESC
        LIMIT 1
      )
    `);

    const c = await getClientSchemaVersion(testDb, clientJournal);
    expect(c.inSync).toBe(false);
    expect(c.pending).toEqual(["0000_client_init"]);

    // Engine probe is untouched by client drift — per-track isolation.
    expect((await getEngineSchemaVersion(testDb)).inSync).toBe(true);

    // Restore the client ledger for later tests.
    const restore = runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);
    expect(restore).toMatch(/\[client\]/);
    expect((await getClientSchemaVersion(testDb, clientJournal)).inSync).toBe(
      true,
    );
  }, 60_000);

  it("boot guard keys off the ENGINE track only (unaffected by client drift)", async () => {
    // Push the client ledger behind again; the guard's input (engine probe)
    // must stay in sync regardless.
    await testDb.execute(sql`
      DELETE FROM drizzle.__client_migrations
      WHERE id = (
        SELECT id FROM drizzle.__client_migrations
        ORDER BY created_at DESC
        LIMIT 1
      )
    `);

    expect((await getEngineSchemaVersion(testDb)).inSync).toBe(true);

    // Restore.
    runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);
    expect((await getClientSchemaVersion(testDb, clientJournal)).inSync).toBe(
      true,
    );
  }, 60_000);

  it("client track on an empty journal is trivially in sync", async () => {
    const v = await getClientSchemaVersion(testDb, { entries: [] });
    expect(v.required).toBeNull();
    expect(v.applied).toBeNull();
    expect(v.pending).toEqual([]);
    expect(v.inSync).toBe(true);
  });
});

describe("health endpoint exposes schema state", () => {
  it("faithfully reports the live schema version", async () => {
    const { createApp, createHogsendClient } = await import("@hogsend/engine");
    const container = createHogsendClient();
    const app = createApp(container);

    // The endpoint should mirror a direct probe of the engine track, whatever
    // the DB's actual state is (we don't assume the dev DB was set up via
    // migrate vs push — only that the endpoint reports the truth).
    const engine: SchemaVersion = await getEngineSchemaVersion(container.db);

    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.schema).toBeDefined();
    expect(body.schema.engine.required).toBe(engine.required);
    expect(body.schema.engine.applied).toBe(engine.applied);
    expect(body.schema.engine.inSync).toBe(engine.inSync);
    expect(body.schema.engine.required).toBe(
      getBundledMigrations().at(-1)?.tag ?? null,
    );

    // apps/api injects no client journal ⇒ the client track is trivially
    // in sync (empty journal).
    expect(body.schema.client).toBeDefined();
    expect(body.schema.client.inSync).toBe(true);
    expect(body.schema.client.pending).toEqual([]);

    if (engine.inSync) {
      expect(body.status).not.toBe("migration_pending");
    }

    await container.dbClient.end();
  });
});
