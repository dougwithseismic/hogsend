import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type JournalShape, migrateClient, migrateEngine } from "@hogsend/db";

/**
 * Two-track migrate runner (the `db:migrate` script).
 *
 *   1. ENGINE track  — bundled `@hogsend/db` migrations, ledger
 *      `drizzle.__drizzle_migrations`. Gates boot (see src/index.ts).
 *   2. CLIENT track  — this repo's `./migrations`, ledger
 *      `drizzle.__client_migrations`. Owned by you; generated via
 *      `pnpm db:generate`.
 *
 * Engine MUST run first so client migrations can reference engine tables.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

// Engine track.
await migrateEngine(databaseUrl);

// Client track — resolve ./migrations relative to the repo root (this file
// lives in ./scripts), read its journal so the version probe can short-circuit.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = join(repoRoot, "migrations");
const journalPath = join(migrationsFolder, "meta", "_journal.json");

if (existsSync(journalPath)) {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalShape;
  if (journal.entries && journal.entries.length > 0) {
    await migrateClient(databaseUrl, migrationsFolder, journal);
  } else {
    console.log("[client] Empty journal — nothing to apply, skipping.");
  }
} else {
  console.log(
    "[client] No migrations/meta/_journal.json — run `pnpm db:generate` first.",
  );
}

console.log("migrations applied (engine + client)");
process.exit(0);
