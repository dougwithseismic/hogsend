import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/db/migrations",
  schema: "./src/db/schema/index.ts",
  dialect: "postgresql",
  // Must match `scripts/migrate.ts` — drizzle-kit stamps the ledger it is told
  // about, and a mismatch would re-apply every migration.
  migrations: {
    schema: "cloud",
    table: "__cloud_migrations",
  },
  dbCredentials: {
    url:
      process.env.CLOUD_DATABASE_URL ??
      "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud",
  },
});
