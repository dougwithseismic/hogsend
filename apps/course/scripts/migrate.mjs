// Programmatic Drizzle migrator for the Railway pre-deploy step. The standalone
// runner has no drizzle-kit, so migrations are applied from the committed SQL in
// ./drizzle using only drizzle-orm + postgres (both traced into the standalone
// via the Better Auth handler). Run: `node apps/course/scripts/migrate.mjs`.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  await migrate(drizzle(sql), {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
  console.log("[migrate] migrations applied");
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
