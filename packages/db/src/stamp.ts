import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  ENGINE_MIGRATIONS_SCHEMA,
  ENGINE_MIGRATIONS_TABLE,
} from "./version.js";

// `db:stamp` — record every bundled engine migration as applied in the ledger
// WITHOUT running any SQL.
//
// Use this when the database schema is already current but the migration ledger
// is behind — the classic case being a dev DB bootstrapped with `db:push`
// (which syncs the schema directly and never writes the ledger). In that state
// `db:migrate` tries to replay migrations whose objects already exist ("type
// already exists") and the boot guard reports `migration_pending`.
//
// WARNING: only run this when you are sure the schema already matches HEAD
// (e.g. it was `db:push`-ed). Stamping a DB that is genuinely missing columns
// would mark migrations applied without creating their objects.

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  // fileURLToPath, NOT `.pathname` — pathname percent-encodes spaces (see
  // migrateEngine).
  const migrationsFolder = fileURLToPath(
    new URL("../drizzle", import.meta.url),
  );
  if (!existsSync(migrationsFolder)) {
    console.log("[stamp] No migrations folder found, nothing to stamp.");
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  const client = postgres(databaseUrl, { max: 1, idle_timeout: 0 });
  const db = drizzle(client);

  const S = sql.identifier(ENGINE_MIGRATIONS_SCHEMA);
  const T = sql.identifier(ENGINE_MIGRATIONS_TABLE);

  try {
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${S}`);
    await db.execute(
      sql`CREATE TABLE IF NOT EXISTS ${S}.${T} ("id" SERIAL PRIMARY KEY, "hash" text NOT NULL, "created_at" bigint)`,
    );

    const existing = (await db.execute(
      sql`SELECT created_at FROM ${S}.${T}`,
    )) as unknown as Array<{ created_at: number | string | null }>;
    const have = new Set(existing.map((r) => String(r.created_at)));

    let inserted = 0;
    for (const m of migrations) {
      if (!have.has(String(m.folderMillis))) {
        await db.execute(
          sql`INSERT INTO ${S}.${T} ("hash", "created_at") VALUES (${m.hash}, ${m.folderMillis})`,
        );
        inserted++;
      }
    }

    console.log(
      `[stamp] Ledger now reflects ${migrations.length} bundled migration(s); inserted ${inserted} missing row(s). No schema changes were applied.`,
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Stamp failed:", err);
      process.exit(1);
    });
}
