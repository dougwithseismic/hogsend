import { sql } from "drizzle-orm";
import journal from "./migrations/meta/_journal.json";

/**
 * The cloud control plane keeps its own ledger, in its own schema, distinct
 * from the engine's `drizzle.__drizzle_migrations` / `drizzle.__client_migrations`.
 * Both `drizzle.config.ts` and `scripts/migrate.ts` must agree with these.
 */
export const CLOUD_MIGRATIONS_SCHEMA = "cloud";
export const CLOUD_MIGRATIONS_TABLE = "__cloud_migrations";

/**
 * Advisory-lock key serializing concurrent migrate runs (two deploys, two
 * replicas, a dev running the script while CI does). DELIBERATELY distinct
 * from the engine's 4812007 — the two tracks are independent databases and
 * must never block each other.
 */
export const CLOUD_ADVISORY_LOCK_KEY = 4812108;

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** Migrations bundled with this build, in application order. */
export function bundledMigrations(): JournalEntry[] {
  return (journal.entries as JournalEntry[])
    .map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }))
    .sort((a, b) => a.idx - b.idx);
}

interface ExecutableDb {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * Rows in the ledger = length of the applied prefix (drizzle applies in journal
 * order, one row per migration). A missing table means nothing applied yet, so
 * the caller sees `0` rather than an exception.
 */
export async function appliedCount(db: ExecutableDb): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS count FROM ${sql.identifier(
      CLOUD_MIGRATIONS_SCHEMA,
    )}.${sql.identifier(CLOUD_MIGRATIONS_TABLE)}`,
  )) as unknown as Array<{ count: number | string }>;
  return Number(rows[0]?.count ?? 0);
}

/** `appliedCount` that treats a missing ledger as "nothing applied". */
export async function appliedCountOrZero(db: ExecutableDb): Promise<number> {
  try {
    return await appliedCount(db);
  } catch {
    return 0;
  }
}
