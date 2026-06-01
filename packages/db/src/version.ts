import { type SQL, sql } from "drizzle-orm";
// The Drizzle journal lists every migration bundled with this build. Importing
// it as JSON lets esbuild/tsup inline it into the API bundle (where the
// `drizzle/` folder isn't shipped) while still working under tsx in dev.
import journal from "../drizzle/meta/_journal.json" with { type: "json" };

/**
 * Minimal shape needed to read the migrations table — satisfied by both the
 * schema-aware container `Database` and the schema-less client the migrator
 * builds, so callers don't have to share an exact drizzle generic.
 */
interface ExecutableDb {
  execute: (query: SQL) => Promise<unknown>;
}

export interface MigrationEntry {
  /** Sequential index assigned by drizzle-kit (0, 1, 2, ...). */
  idx: number;
  /** Migration filename without extension, e.g. `0007_serious_captain_universe`. */
  tag: string;
  /** Creation timestamp (ms). Matches `__drizzle_migrations.created_at`. */
  when: number;
}

export interface SchemaVersion {
  /** Latest migration tag bundled with this build (what the code requires). */
  required: string | null;
  /** Latest migration tag actually applied to the database. */
  applied: string | null;
  /** Bundled migrations not yet applied to the database, in order. */
  pending: string[];
  /** True when every bundled migration has been applied. */
  inSync: boolean;
}

/**
 * The relevant slice of a Drizzle `meta/_journal.json` — the entries a track's
 * code requires. Both the engine (bundled journal) and the client (its own repo
 * journal, supplied by the caller) are described by this shape.
 */
export interface JournalShape {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

// --- Two-track ledger constants -------------------------------------------
//
// Each migration track records what it has applied in its own ledger table,
// both living in the `drizzle` schema (D4: two ledgers, one schema). The engine
// values MUST match Drizzle's defaults so the existing populated
// `drizzle.__drizzle_migrations` ledger keeps working with zero re-stamping.

/** Engine ledger schema (Drizzle default). */
export const ENGINE_MIGRATIONS_SCHEMA = "drizzle";
/** Engine ledger table (Drizzle default). */
export const ENGINE_MIGRATIONS_TABLE = "__drizzle_migrations";
/** Client ledger schema — sibling of the engine ledger in the same schema. */
export const CLIENT_MIGRATIONS_SCHEMA = "drizzle";
/** Client ledger table. */
export const CLIENT_MIGRATIONS_TABLE = "__client_migrations";

/** Source describing one track: its required journal + where it records state. */
export interface VersionSource {
  /** Journal entries (idx/tag/when) that this track's code requires. */
  journal: JournalShape;
  /** Ledger schema, e.g. "drizzle". */
  ledgerSchema: string;
  /** Ledger table, e.g. "__drizzle_migrations" / "__client_migrations". */
  ledgerTable: string;
}

/** Migration entries for a journal, ordered by index. */
function getJournalEntries(j: JournalShape): MigrationEntry[] {
  return j.entries
    .map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }))
    .sort((a, b) => a.idx - b.idx);
}

/** Migrations bundled into this build (engine track), ordered by index. */
export function getBundledMigrations(): MigrationEntry[] {
  return getJournalEntries(journal as JournalShape);
}

/**
 * Compare a track's required migrations against those recorded in its ledger.
 * Count-based: Drizzle applies migrations in journal order and inserts one row
 * per applied migration, so the ledger row count is the length of the applied
 * prefix. Robust to how Drizzle stamps `created_at` and to a DB ahead of build.
 *
 * Note: a database *ahead* of the build (more migrations applied than bundled —
 * e.g. during a rollback to older code) still reports `inSync: true`, because
 * every migration the code requires is present. That is the expand/contract
 * contract: old code is compatible with a newer schema.
 */
async function readSchemaVersion(
  db: ExecutableDb,
  source: VersionSource,
): Promise<SchemaVersion> {
  const bundled = getJournalEntries(source.journal);
  const required = bundled.at(-1)?.tag ?? null;

  let appliedCount = 0;
  try {
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS count FROM ${sql.identifier(
        source.ledgerSchema,
      )}.${sql.identifier(source.ledgerTable)}`,
    )) as unknown as Array<{ count: number | string }>;
    appliedCount = Number(rows[0]?.count ?? 0);
  } catch {
    // The migrations table doesn't exist yet → nothing has been applied.
  }

  const applied =
    appliedCount > 0
      ? (bundled[appliedCount - 1]?.tag ?? bundled.at(-1)?.tag ?? null)
      : null;
  const pending = bundled.slice(appliedCount).map((e) => e.tag);

  return { required, applied, pending, inSync: appliedCount >= bundled.length };
}

/**
 * Engine track version — bundled journal vs `drizzle.__drizzle_migrations`.
 * Drives the migrator's logging, the API boot guard, and the engine portion of
 * the `schema` block of `GET /v1/health`.
 */
export async function getEngineSchemaVersion(
  db: ExecutableDb,
): Promise<SchemaVersion> {
  return readSchemaVersion(db, {
    journal: journal as JournalShape,
    ledgerSchema: ENGINE_MIGRATIONS_SCHEMA,
    ledgerTable: ENGINE_MIGRATIONS_TABLE,
  });
}

/**
 * Client track version — the caller supplies its own journal (the client repo's
 * `migrations/meta/_journal.json`), recorded in `drizzle.__client_migrations`.
 * An empty journal (`{ entries: [] }`) is trivially in sync.
 */
export async function getClientSchemaVersion(
  db: ExecutableDb,
  clientJournal: JournalShape,
): Promise<SchemaVersion> {
  return readSchemaVersion(db, {
    journal: clientJournal,
    ledgerSchema: CLIENT_MIGRATIONS_SCHEMA,
    ledgerTable: CLIENT_MIGRATIONS_TABLE,
  });
}

/**
 * BACK-COMPAT default — equals the engine track. The boot guard, `/v1/health`,
 * and existing tests import this; keep it as a one-line delegate so their
 * behavior is unchanged.
 */
export async function getSchemaVersion(
  db: ExecutableDb,
): Promise<SchemaVersion> {
  return getEngineSchemaVersion(db);
}
