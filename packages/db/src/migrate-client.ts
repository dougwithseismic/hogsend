import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrateClient } from "./migrate.js";
import type { JournalShape } from "./version.js";

// Client-track migrate CLI shim. Reads the client repo's migrations folder from
// `CLIENT_MIGRATIONS_FOLDER` (set per service to the client repo's `migrations`
// dir), loads its journal, and applies it into `drizzle.__client_migrations`.
//
// Skips gracefully when the folder is unset/absent/empty so the same railway
// `preDeployCommand` works for this dogfood repo (no client migrations) and for
// scaffolded client repos.
async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const folder = process.env.CLIENT_MIGRATIONS_FOLDER;
  if (!folder) {
    console.log(
      "[client] CLIENT_MIGRATIONS_FOLDER not set — no client migrations to apply, skipping.",
    );
    return;
  }
  if (!existsSync(folder)) {
    console.log(`[client] Migrations folder ${folder} not found — skipping.`);
    return;
  }

  const journalPath = join(folder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    console.log(
      `[client] No meta/_journal.json in ${folder} — empty client track, skipping.`,
    );
    return;
  }

  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalShape;
  if (!journal.entries || journal.entries.length === 0) {
    console.log("[client] Empty journal — nothing to apply, skipping.");
    return;
  }

  await migrateClient(databaseUrl, folder, journal);
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Client migration failed:", err);
    process.exit(1);
  });
