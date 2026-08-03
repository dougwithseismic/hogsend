import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/** The pool size used when `DATABASE_POOL_MAX` is unset or unusable. */
export const DEFAULT_POOL_MAX = 10;
/**
 * Ceiling on the configurable pool size. A tenant stack on a shared Postgres
 * cell gets a small slice of `max_connections`; anything above this is a
 * misconfiguration that would starve its neighbours.
 */
export const MAX_POOL_MAX = 50;

/**
 * Parse `DATABASE_POOL_MAX`. Positive integer, capped at {@link MAX_POOL_MAX};
 * anything else (absent, non-numeric, zero/negative, fractional, over the cap)
 * falls back to {@link DEFAULT_POOL_MAX}. NEVER throws — a bad value must not
 * take the process down at boot; `invalid` lets the caller warn once.
 *
 * Note the DSN's own `?max=` query param is silently ignored by `postgres.js`
 * when options are passed, which is why this is an explicit env read.
 */
export function parsePoolMax(raw: string | undefined): {
  max: number;
  invalid: boolean;
} {
  if (raw === undefined || raw.trim() === "") {
    return { max: DEFAULT_POOL_MAX, invalid: false };
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POOL_MAX) {
    return { max: DEFAULT_POOL_MAX, invalid: true };
  }
  return { max: parsed, invalid: false };
}

export function createDatabase(opts: { url: string }) {
  const { max, invalid } = parsePoolMax(process.env.DATABASE_POOL_MAX);
  if (invalid) {
    // One line, once, at boot. `packages/db` has no logger dependency (raw .ts,
    // no build step, bundled by consumers) so this is a bare console.warn.
    console.warn(
      `[hogsend/db] Ignoring invalid DATABASE_POOL_MAX="${process.env.DATABASE_POOL_MAX}" — expected an integer 1-${MAX_POOL_MAX}. Using ${DEFAULT_POOL_MAX}.`,
    );
  }

  const client = postgres(opts.url, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  const db = drizzle(client, { schema });

  return { db, client };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type DatabaseClient = ReturnType<typeof postgres>;

export { migrateClient, migrateEngine, migrateTrack } from "./migrate.js";
export * from "./schema/index.js";
export {
  CLIENT_MIGRATIONS_SCHEMA,
  CLIENT_MIGRATIONS_TABLE,
  ENGINE_MIGRATIONS_SCHEMA,
  ENGINE_MIGRATIONS_TABLE,
  getBundledMigrations,
  getClientSchemaVersion,
  getEngineSchemaVersion,
  getSchemaVersion,
  type JournalShape,
  type MigrationEntry,
  type SchemaVersion,
} from "./version.js";
export { schema };
