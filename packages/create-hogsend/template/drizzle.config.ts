import { defineConfig } from "drizzle-kit";

/**
 * CLIENT migration track. `db:generate` / `db:push` write here and reference the
 * `drizzle.__client_migrations` ledger — NEVER the engine's
 * `__drizzle_migrations`. Engine tables migrate separately via `@hogsend/db`
 * (run first by `scripts/migrate.ts`).
 */
export default defineConfig({
  out: "./migrations",
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  migrations: {
    table: "__client_migrations",
    schema: "drizzle",
  },
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://hogsend:hogsend@localhost:5434/hogsend",
  },
});
