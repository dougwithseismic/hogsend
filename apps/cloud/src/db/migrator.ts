import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  appliedCountOrZero,
  bundledMigrations,
  CLOUD_ADVISORY_LOCK_KEY,
  CLOUD_MIGRATIONS_SCHEMA,
  CLOUD_MIGRATIONS_TABLE,
} from "./ledger";

export interface MigrateResult {
  /** Migrations already recorded in the ledger before this run. */
  alreadyApplied: number;
  /** Tags this run applied (empty on a no-op second run). */
  applied: string[];
  /** True when every bundled migration is now recorded. */
  inSync: boolean;
}

/** Postgres error code for "database does not exist". */
const UNDEFINED_DATABASE = "3D000";

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/**
 * Create the target database if it doesn't exist yet, by connecting to the
 * server's `postgres` maintenance database. Keeps `db:migrate` a ONE-command
 * bootstrap on a fresh clone / fresh CI runner, where the compose Postgres only
 * ships the engine's `growthhog` database.
 */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!name) throw new Error("CLOUD_DATABASE_URL has no database name");

  const probe = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await probe`SELECT 1`;
    return;
  } catch (err) {
    if (errorCode(err) !== UNDEFINED_DATABASE) throw err;
  } finally {
    await probe.end({ timeout: 5 });
  }

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    // Serialize concurrent creators (parallel test files, two replicas booting
    // together). CREATE DATABASE cannot run in a transaction, so this session
    // lock — not a transactional one — is the only available gate.
    await admin`SELECT pg_advisory_lock(${CLOUD_ADVISORY_LOCK_KEY})`;
    try {
      // `CREATE DATABASE` takes no parameters, so the name goes through
      // postgres-js's identifier escaping.
      await admin`CREATE DATABASE ${admin(name)}`;
      console.log(`[cloud] Created database "${name}".`);
    } catch (err) {
      // A lost race surfaces under several codes (42P04, 23505 on
      // pg_database_datname_index, 55006). Rather than enumerate them, ask the
      // only question that matters: does the database exist now?
      const [row] = await admin<Array<{ exists: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS exists
      `;
      if (!row?.exists) throw err;
    } finally {
      await admin`SELECT pg_advisory_unlock(${CLOUD_ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Apply the cloud migration track. Idempotent: a second run finds the ledger
 * already at HEAD and applies nothing.
 */
export async function runCloudMigrations(
  databaseUrl: string,
): Promise<MigrateResult> {
  await ensureDatabase(databaseUrl);

  const bundled = bundledMigrations();
  const migrationsFolder = fileURLToPath(
    new URL("./migrations", import.meta.url),
  );

  // One dedicated connection; `idle_timeout: 0` keeps it from dropping while a
  // long DDL statement runs and taking the advisory lock with it.
  const client = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 0,
    onnotice: () => {},
    connection: { application_name: "hogsend-cloud-migrate" },
  });
  const db = drizzle(client);

  try {
    // Fail fast rather than queueing forever behind a lock.
    await client`SET lock_timeout = '10s'`;
    await client`SET statement_timeout = '15min'`;
    await client`SELECT pg_advisory_lock(${CLOUD_ADVISORY_LOCK_KEY})`;
    try {
      const before = await appliedCountOrZero(db);
      if (before >= bundled.length) {
        console.log(
          `[cloud] Schema already up to date at ${bundled.at(-1)?.tag ?? "(empty)"} — nothing to apply.`,
        );
        return { alreadyApplied: before, applied: [], inSync: true };
      }
      const pending = bundled.slice(before).map((e) => e.tag);
      console.log(
        `[cloud] Applying ${pending.length} migration(s): ${pending.join(", ")}`,
      );
      await migrate(db, {
        migrationsFolder,
        migrationsTable: CLOUD_MIGRATIONS_TABLE,
        migrationsSchema: CLOUD_MIGRATIONS_SCHEMA,
      });
      const after = await appliedCountOrZero(db);
      console.log(
        `[cloud] Migrations complete. Schema now at ${bundled[after - 1]?.tag ?? "(empty)"}.`,
      );
      return {
        alreadyApplied: before,
        applied: bundled.slice(before, after).map((e) => e.tag),
        inSync: after >= bundled.length,
      };
    } finally {
      await client`SELECT pg_advisory_unlock(${CLOUD_ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await client.end();
  }
}
