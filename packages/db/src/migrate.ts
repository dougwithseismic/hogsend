import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  CLIENT_MIGRATIONS_SCHEMA,
  CLIENT_MIGRATIONS_TABLE,
  ENGINE_MIGRATIONS_SCHEMA,
  ENGINE_MIGRATIONS_TABLE,
  getClientSchemaVersion,
  getEngineSchemaVersion,
  type JournalShape,
  type SchemaVersion,
} from "./version.js";

// Stable advisory-lock key so two concurrent deploys / replicas can never run
// migrations at the same time — the second blocks on the lock. Both tracks use
// the same key: a client migrate cannot race an engine migrate on the same DB
// (the desired serialization, not a bug), and sequential engine-then-client
// calls each acquire+release so there is no deadlock.
const ADVISORY_LOCK_KEY = 4812007;

type Db = ReturnType<typeof drizzle>;
type Client = ReturnType<typeof postgres>;

export interface MigrateTrackOptions {
  /** Already-constructed postgres-js client (max:1, idle_timeout:0). */
  client: Client;
  /** drizzle(client) instance bound to that client. */
  db: Db;
  migrationsFolder: string;
  migrationsTable: string;
  migrationsSchema: string;
  /** Per-track version probe so logging reports the right pending set. */
  version: (db: Db) => Promise<SchemaVersion>;
  /** Label for log lines, e.g. "engine" / "client". */
  label: string;
}

/**
 * Apply one migration track under the shared advisory lock + statement guards.
 * Generalized from the original single-track `run()`.
 */
export async function migrateTrack(opts: MigrateTrackOptions): Promise<void> {
  const { client, db, migrationsFolder, migrationsTable, migrationsSchema } =
    opts;

  // Fail fast instead of queueing forever behind a lock on a busy table; a
  // migration that can't get its lock in 10s is safer aborted and retried.
  await client`SET lock_timeout = '10s'`;
  // Cap any single statement. Long-running DDL or bulk UPDATEs against a live
  // table belong in a Hatchet backfill job, not in a migration (UPGRADING.md).
  await client`SET statement_timeout = '15min'`;

  // Serialize migrations across concurrent deploys / multiple replicas.
  await client`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    const before = await opts.version(db);
    if (before.inSync) {
      console.log(
        `[${opts.label}] Schema already up to date at ${before.applied ?? "(empty)"} — nothing to apply.`,
      );
      return;
    }
    console.log(
      `[${opts.label}] Applying ${before.pending.length} migration(s): ${before.pending.join(", ")}`,
    );
    await migrate(db, { migrationsFolder, migrationsTable, migrationsSchema });
    const after = await opts.version(db);
    console.log(
      `[${opts.label}] Migrations complete. Schema now at ${after.applied}.`,
    );
  } finally {
    await client`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

function createMigrateClient(databaseUrl: string): { client: Client; db: Db } {
  // Single dedicated connection. `idle_timeout: 0` keeps it from dropping
  // mid-run. `onnotice` swallows Postgres NOTICEs (e.g. `CREATE SCHEMA IF NOT
  // EXISTS` reporting `schema "drizzle" already exists, skipping`) which
  // postgres-js otherwise dumps as raw objects mid-output.
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    onnotice: () => {},
    connection: { application_name: "hogsend-migrate" },
  });
  return { client, db: drizzle(client) };
}

/** Engine track: bundled `@hogsend/db/drizzle` folder + default ledger. */
export async function migrateEngine(databaseUrl: string): Promise<void> {
  const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;
  if (!existsSync(migrationsFolder)) {
    console.log("[engine] No migrations folder found, skipping.");
    return;
  }
  const { client, db } = createMigrateClient(databaseUrl);
  try {
    await migrateTrack({
      client,
      db,
      migrationsFolder,
      migrationsTable: ENGINE_MIGRATIONS_TABLE,
      migrationsSchema: ENGINE_MIGRATIONS_SCHEMA,
      version: getEngineSchemaVersion,
      label: "engine",
    });
  } finally {
    await client.end();
  }
}

/**
 * Client track: the caller's migrations folder + `__client_migrations` ledger.
 * The caller also supplies the client journal so the version probe can
 * short-circuit on an already-in-sync ledger.
 */
export async function migrateClient(
  databaseUrl: string,
  migrationsFolder: string,
  journal: JournalShape,
): Promise<void> {
  if (!existsSync(migrationsFolder)) {
    console.log("[client] No migrations folder found, skipping.");
    return;
  }
  const { client, db } = createMigrateClient(databaseUrl);
  try {
    await migrateTrack({
      client,
      db,
      migrationsFolder,
      migrationsTable: CLIENT_MIGRATIONS_TABLE,
      migrationsSchema: CLIENT_MIGRATIONS_SCHEMA,
      version: (d) => getClientSchemaVersion(d, journal),
      label: "client",
    });
  } finally {
    await client.end();
  }
}

// --- CLI entrypoint (the `db:migrate` script) -----------------------------
//
// Engine only. `@hogsend/db` has no knowledge of any client repo's migrations
// folder, so the client track is invoked separately via `migrate-client.ts`
// (the `db:migrate:client` script).
async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }
  await migrateEngine(databaseUrl);
}

// Only run when invoked directly (e.g. `tsx src/migrate.ts`). Guard so that
// re-exporting `migrateEngine`/`migrateClient` from `index.ts` does not fire a
// real migration + `process.exit` at import time.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
