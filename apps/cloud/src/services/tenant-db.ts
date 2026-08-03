import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { CloudServiceError } from "./errors";

/**
 * Tenant database provisioning on a cell's SHARED Postgres cluster.
 *
 * One tenant stack = one database + one login role of the same name, owned by
 * that role and reachable by nobody else. The laws this module exists to hold:
 *
 *  - **Isolation is by GRANT, not by convention.** Every database is created,
 *    then `REVOKE ALL ... FROM PUBLIC` and `GRANT CONNECT` to exactly one role.
 *    Without the revoke, PUBLIC keeps the default CONNECT and every tenant on
 *    the cell can open every other tenant's database.
 *  - **Identifiers are validated AND quoted.** `dbName` is checked against
 *    {@link TENANT_DB_NAME_RE} before a single statement is built, and is then
 *    interpolated only through {@link quoteIdent}. Neither alone is enough: the
 *    regex is the real guard, the quoting is the belt.
 *  - **A re-create never rotates a live password.** Provisioning is a replayed
 *    durable step; if the second run silently issued new credentials, the
 *    already-deployed stack would keep the old ones and lose its database. So a
 *    create that finds the database present returns `alreadyExists` with NO
 *    dsn, and recovering a lost password is an EXPLICIT, separate call
 *    ({@link TenantDbService.resetCredentials}).
 *  - **Nothing here logs a DSN or a password.** Errors carry the database name
 *    only.
 *
 * ## Pool size
 *
 * The PRD sketched a `?pool_max=3`-style DSN parameter. It does not work:
 * postgres-js reads `max` from the URL only when the caller passes no explicit
 * `max`, and the engine's `createDatabase` (`packages/db/src/index.ts`) always
 * passes `max: 10`. A URL param would therefore be silently ignored — the worst
 * possible outcome for a knob whose whole job is to stop per-tenant stacks
 * holding fat pools against a shared cluster. There is no engine env knob for
 * it today either.
 *
 * So the DSN stays CLEAN and the intended ceiling travels beside it as
 * {@link TenantDbResult.poolMax}. The provision pipeline (task 3) carries it
 * into the stack's env; when the engine grows a pool-size env var it is a
 * one-line change there and no re-provision here.
 */

/**
 * Postgres identifiers are 63 bytes; the role shares the name, so one rule
 * covers both. Leading letter + `[a-z0-9_]` keeps every name unquoted-safe and
 * folding-stable (Postgres downcases unquoted identifiers — a name that only
 * survives quoting is a trap).
 */
export const TENANT_DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** The per-tenant connection ceiling. See the pool-size note above. */
export const TENANT_POOL_MAX = 3;

/** A tenant database name failed {@link TENANT_DB_NAME_RE}. */
export class InvalidTenantDbNameError extends CloudServiceError {
  readonly code = "invalid_tenant_db_name";

  constructor(readonly dbName: string) {
    super(
      `Invalid tenant database name "${dbName}" — expected ${TENANT_DB_NAME_RE.source}`,
    );
  }
}

/** An operation needed an existing tenant database and found none. */
export class TenantDbNotFoundError extends CloudServiceError {
  readonly code = "tenant_db_not_found";

  constructor(readonly dbName: string) {
    super(`Tenant database "${dbName}" does not exist on this cell`);
  }
}

/** A destructive call arrived without its matching confirmation. */
export class DestroyConfirmationError extends CloudServiceError {
  readonly code = "destroy_confirmation_mismatch";

  constructor(readonly dbName: string) {
    super(
      `Refusing to drop tenant database "${dbName}": confirmation did not match the database name`,
    );
  }
}

/** True when `name` is a legal tenant database (and role) name. */
export function isTenantDbName(name: string): boolean {
  return TENANT_DB_NAME_RE.test(name);
}

/**
 * Validate and return `name`, or throw {@link InvalidTenantDbNameError}.
 * Exported because the provision pipeline derives the name from a stack id and
 * must reject an illegal one at the SAME boundary this service does.
 */
export function assertTenantDbName(name: string): string {
  if (!isTenantDbName(name)) throw new InvalidTenantDbNameError(name);
  return name;
}

/** Double-quote an identifier, escaping embedded quotes. Belt to the regex. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a string literal, escaping embedded quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 32 hex chars — 128 bits, and free of anything needing SQL/URL escaping. */
function generatePassword(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Build the tenant DSN from the cell's admin DSN: same host/port/params, the
 * tenant's own credentials and database. Deliberately re-uses the admin DSN's
 * query string so a cell that requires `sslmode=require` keeps requiring it.
 */
function buildTenantDsn(
  cellDsn: string,
  dbName: string,
  password: string,
): string {
  const url = new URL(cellDsn);
  url.username = encodeURIComponent(dbName);
  url.password = encodeURIComponent(password);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withAdmin<T>(
  cellDsn: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(cellDsn, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 1,
    // DDL chatter ("role does not exist, skipping") is not our operator's
    // problem; real failures still throw.
    onnotice: () => {},
    connection: { application_name: "hogsend-cloud-provisioner" },
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function databaseExists(
  sql: postgres.Sql,
  dbName: string,
): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
  return rows.length > 0;
}

async function roleExists(sql: postgres.Sql, dbName: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${dbName}`;
  return rows.length > 0;
}

export interface TenantDbTarget {
  /** The cell's ADMIN dsn (decrypted `cells.shared_cluster_dsn`). */
  cellDsn: string;
  /** Tenant database AND role name. Must satisfy {@link TENANT_DB_NAME_RE}. */
  dbName: string;
}

export interface TenantDbCredentials {
  /** Ready-to-use tenant DSN. NEVER log this — it carries the password. */
  dsn: string;
  /** The connection ceiling the pipeline must impose. See the pool-size note. */
  poolMax: number;
}

export type CreateTenantDbResult =
  | (TenantDbCredentials & { alreadyExists: false })
  /**
   * The database was already there, so its password is whatever the first
   * create handed out — unknowable here and NOT rotated. Call
   * `resetCredentials` if the caller genuinely lost it.
   */
  | { alreadyExists: true; dsn: null; poolMax: number };

export interface DropTenantDbInput extends TenantDbTarget {
  /** Must equal `dbName`. The destroy guard. */
  confirm: string;
}

export interface DropTenantDbResult {
  droppedDatabase: boolean;
  droppedRole: boolean;
}

/**
 * Postgres SQLSTATEs for "someone else won the race" — a concurrent
 * provisioner created the role/database between our catalog check and our
 * CREATE. Both mean the same thing: it exists, carry on.
 */
const DUPLICATE_DATABASE = "42P04";
const DUPLICATE_OBJECT = "42710";

function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
}

export class TenantDbService {
  /**
   * Idempotently create the tenant's role + database.
   *
   * Idempotency is by CATALOG CHECK, not `IF NOT EXISTS` — `CREATE DATABASE`
   * has no such clause, and the role/database pair must be judged together:
   * a run that crashed between the two leaves an orphan role whose password
   * nobody holds, which we complete by rotating that orphan (safe precisely
   * because no database ever existed for it to authenticate against).
   */
  async create(input: TenantDbTarget): Promise<CreateTenantDbResult> {
    const dbName = assertTenantDbName(input.dbName);
    const ident = quoteIdent(dbName);

    return withAdmin(input.cellDsn, async (sql) => {
      if (await databaseExists(sql, dbName)) {
        return { alreadyExists: true, dsn: null, poolMax: TENANT_POOL_MAX };
      }

      const password = generatePassword();

      // The role: no superuser, no createdb, no createrole. A tenant may own
      // its own database and nothing else on the cell.
      if (await roleExists(sql, dbName)) {
        // Orphan from a half-finished run — adopt it under a fresh password.
        await sql.unsafe(
          `ALTER ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD ${quoteLiteral(password)}`,
        );
      } else {
        try {
          await sql.unsafe(
            `CREATE ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD ${quoteLiteral(password)}`,
          );
        } catch (error) {
          if (sqlState(error) !== DUPLICATE_OBJECT) throw error;
          await sql.unsafe(
            `ALTER ROLE ${ident} WITH PASSWORD ${quoteLiteral(password)}`,
          );
        }
      }

      try {
        await sql.unsafe(`CREATE DATABASE ${ident} OWNER ${ident}`);
      } catch (error) {
        if (sqlState(error) !== DUPLICATE_DATABASE) throw error;
        // Lost the race: the winner's password is live, ours is not. Report
        // existence rather than hand back a credential that may be stale.
        return { alreadyExists: true, dsn: null, poolMax: TENANT_POOL_MAX };
      }

      // Isolation. Without the revoke, PUBLIC keeps its default CONNECT and
      // every other tenant role on the cell can open this database.
      await sql.unsafe(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`);
      await sql.unsafe(`GRANT CONNECT ON DATABASE ${ident} TO ${ident}`);

      return {
        alreadyExists: false,
        dsn: buildTenantDsn(input.cellDsn, dbName, password),
        poolMax: TENANT_POOL_MAX,
      };
    });
  }

  /**
   * Rotate the tenant role's password and return a working DSN.
   *
   * The recovery path for a create whose credential was lost (a pipeline that
   * died before persisting it). Explicit on purpose: it INVALIDATES the DSN a
   * running stack may still be holding, so the caller must be the one that
   * re-sets the stack env afterwards.
   */
  async resetCredentials(input: TenantDbTarget): Promise<TenantDbCredentials> {
    const dbName = assertTenantDbName(input.dbName);
    const ident = quoteIdent(dbName);

    return withAdmin(input.cellDsn, async (sql) => {
      if (!(await databaseExists(sql, dbName))) {
        throw new TenantDbNotFoundError(dbName);
      }
      const password = generatePassword();
      if (await roleExists(sql, dbName)) {
        await sql.unsafe(
          `ALTER ROLE ${ident} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
        );
      } else {
        // Database without its role — re-mint and re-own it.
        await sql.unsafe(
          `CREATE ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD ${quoteLiteral(password)}`,
        );
        await sql.unsafe(`ALTER DATABASE ${ident} OWNER TO ${ident}`);
      }
      await sql.unsafe(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`);
      await sql.unsafe(`GRANT CONNECT ON DATABASE ${ident} TO ${ident}`);

      return {
        dsn: buildTenantDsn(input.cellDsn, dbName, password),
        poolMax: TENANT_POOL_MAX,
      };
    });
  }

  /**
   * Terminate every backend on the database, then drop it and its role.
   *
   * `confirm` must equal `dbName`. The guard is checked BEFORE anything else
   * runs, so a refused destroy leaves the cluster untouched — a half-executed
   * guard (backends killed, database kept) would be worse than none.
   *
   * A repeat drop is a no-op returning `false`s, not an error: the destroy step
   * is replayable like every other.
   */
  async drop(input: DropTenantDbInput): Promise<DropTenantDbResult> {
    const dbName = assertTenantDbName(input.dbName);
    if (input.confirm !== dbName) throw new DestroyConfirmationError(dbName);
    const ident = quoteIdent(dbName);

    return withAdmin(input.cellDsn, async (sql) => {
      const existed = await databaseExists(sql, dbName);
      const hadRole = await roleExists(sql, dbName);

      if (existed) {
        // New connections first, then the ones already in: otherwise a
        // reconnecting client races the DROP forever.
        await sql.unsafe(
          `REVOKE CONNECT ON DATABASE ${ident} FROM PUBLIC, ${ident}`,
        );
        await sql`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = ${dbName} AND pid <> pg_backend_pid()`;
        await sql.unsafe(`DROP DATABASE IF EXISTS ${ident}`);
      }
      if (hadRole) {
        await sql.unsafe(`DROP ROLE IF EXISTS ${ident}`);
      }

      return { droppedDatabase: existed, droppedRole: hadRole };
    });
  }
}
