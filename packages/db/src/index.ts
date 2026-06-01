import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDatabase(opts: { url: string }) {
  const client = postgres(opts.url, {
    max: 10,
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
