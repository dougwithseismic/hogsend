import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertTenantDbName,
  DestroyConfirmationError,
  InvalidTenantDbNameError,
  isTenantDbName,
  TenantDbNotFoundError,
  TenantDbService,
} from "../services/tenant-db";

/**
 * Against a REAL cluster. Everything this service claims — that PUBLIC cannot
 * connect, that role A is locked out of database B, that a second create does
 * not rotate a live password — is a fact about Postgres catalogs and grants. A
 * mocked driver would assert only that we typed the right SQL string.
 *
 * The "cell" here is the repo's docker-compose Postgres on 5434, whose
 * `growthhog` superuser plays the shared cluster's admin DSN.
 *
 * LAW (see the vitest config): the default MUST be port 5434 so CI works with
 * nothing exported locally.
 */
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";

const service = new TenantDbService();

/** Unique per run: a failed run must never poison the next one. */
function tenantName(): string {
  return `t_${randomBytes(6).toString("hex")}`;
}

const created: string[] = [];

function track(name: string): string {
  created.push(name);
  return name;
}

/** Open a short-lived connection AS the tenant role and run `fn`. */
async function asTenant<T>(
  dsn: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(dsn, { max: 1, connect_timeout: 10, idle_timeout: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

afterAll(async () => {
  for (const name of created) {
    await service
      .drop({ cellDsn: CLUSTER_DSN, dbName: name, confirm: name })
      .catch(() => {});
  }
});

describe("tenant database name validation", () => {
  // Pure unit — no cluster required, so a broken local Docker still proves the
  // injection guard.
  it("accepts lowercase identifiers within the length ceiling", () => {
    expect(isTenantDbName("t")).toBe(true);
    expect(isTenantDbName("tenant_db_1")).toBe(true);
    expect(isTenantDbName(`a${"b".repeat(62)}`)).toBe(true);
  });

  it("rejects anything that could ride into an identifier", () => {
    for (const bad of [
      "",
      "1tenant",
      "_tenant",
      "Tenant",
      "tenant-db",
      "tenant db",
      'tenant"; DROP DATABASE postgres; --',
      "tenant;",
      `a${"b".repeat(63)}`,
    ]) {
      expect(isTenantDbName(bad)).toBe(false);
      expect(() => assertTenantDbName(bad)).toThrow(InvalidTenantDbNameError);
    }
  });

  it("refuses an invalid name before touching the cluster", async () => {
    await expect(
      service.create({ cellDsn: CLUSTER_DSN, dbName: "Bad-Name" }),
    ).rejects.toBeInstanceOf(InvalidTenantDbNameError);
  });
});

describe("TenantDbService against the cell cluster", () => {
  it("creates an owned database the tenant role can use", async () => {
    const name = track(tenantName());
    const result = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });

    expect(result.alreadyExists).toBe(false);
    if (result.alreadyExists) throw new Error("unreachable");
    expect(result.dsn).toContain(`/${name}`);
    // The DSN carries NO pool params — postgres-js ignores URL `max` whenever
    // the caller passes one explicitly, which the engine does. The pipeline
    // carries `poolMax` instead.
    expect(result.dsn).not.toContain("pool_max");
    expect(result.poolMax).toBe(3);

    const rows = await asTenant(result.dsn, async (sql) => {
      await sql.unsafe("CREATE TABLE probe (id int primary key)");
      await sql.unsafe("INSERT INTO probe (id) VALUES (1)");
      return sql.unsafe<{ id: number }[]>("SELECT id FROM probe");
    });
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("is idempotent: a re-create never rotates a live password", async () => {
    const name = track(tenantName());
    const first = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });
    if (first.alreadyExists) throw new Error("expected a fresh create");

    const second = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });
    expect(second.alreadyExists).toBe(true);
    expect(second.dsn).toBeNull();

    // The password handed out by the first create still works.
    const [row] = await asTenant(first.dsn, (sql) =>
      sql.unsafe<{ ok: number }[]>("SELECT 1 AS ok"),
    );
    expect(row).toEqual({ ok: 1 });
  });

  it("recovers a lost password through resetCredentials", async () => {
    const name = track(tenantName());
    const first = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });
    if (first.alreadyExists) throw new Error("expected a fresh create");

    const reset = await service.resetCredentials({
      cellDsn: CLUSTER_DSN,
      dbName: name,
    });
    expect(reset.dsn).not.toBe(first.dsn);
    expect(reset.poolMax).toBe(3);

    const [row] = await asTenant(reset.dsn, (sql) =>
      sql.unsafe<{ ok: number }[]>("SELECT 1 AS ok"),
    );
    expect(row).toEqual({ ok: 1 });

    // The superseded credential is dead.
    await expect(
      asTenant(first.dsn, (sql) => sql.unsafe("SELECT 1")),
    ).rejects.toThrow();
  });

  it("refuses resetCredentials for a database that does not exist", async () => {
    await expect(
      service.resetCredentials({
        cellDsn: CLUSTER_DSN,
        dbName: tenantName(),
      }),
    ).rejects.toBeInstanceOf(TenantDbNotFoundError);
  });

  it("locks each tenant out of every other tenant's database", async () => {
    const a = track(tenantName());
    const b = track(tenantName());
    const createdA = await service.create({ cellDsn: CLUSTER_DSN, dbName: a });
    const createdB = await service.create({ cellDsn: CLUSTER_DSN, dbName: b });
    if (createdA.alreadyExists || createdB.alreadyExists) {
      throw new Error("expected two fresh creates");
    }

    // Role A's own credentials, pointed at database B.
    const crossDsn = createdA.dsn.replace(new RegExp(`/${a}$`), `/${b}`);
    expect(crossDsn).toContain(`/${b}`);
    await expect(
      asTenant(crossDsn, (sql) => sql.unsafe("SELECT 1")),
    ).rejects.toThrow(/permission denied for database/i);
  });

  it("drops only when the confirmation matches the database name", async () => {
    const name = track(tenantName());
    const result = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });
    if (result.alreadyExists) throw new Error("expected a fresh create");

    await expect(
      service.drop({
        cellDsn: CLUSTER_DSN,
        dbName: name,
        confirm: `${name}_nope`,
      }),
    ).rejects.toBeInstanceOf(DestroyConfirmationError);

    // Still alive after the refused destroy — a guard that half-runs is worse
    // than no guard.
    const [alive] = await asTenant(result.dsn, (sql) =>
      sql.unsafe<{ ok: number }[]>("SELECT 1 AS ok"),
    );
    expect(alive).toEqual({ ok: 1 });

    const dropped = await service.drop({
      cellDsn: CLUSTER_DSN,
      dbName: name,
      confirm: name,
    });
    expect(dropped).toEqual({ droppedDatabase: true, droppedRole: true });

    const admin = postgres(CLUSTER_DSN, { max: 1, idle_timeout: 1 });
    try {
      const dbs = await admin`
        SELECT datname FROM pg_database WHERE datname = ${name}`;
      const roles = await admin`
        SELECT rolname FROM pg_roles WHERE rolname = ${name}`;
      expect(dbs).toHaveLength(0);
      expect(roles).toHaveLength(0);
    } finally {
      await admin.end({ timeout: 5 });
    }

    // A second drop is a no-op, not an error (replayed destroy step).
    expect(
      await service.drop({
        cellDsn: CLUSTER_DSN,
        dbName: name,
        confirm: name,
      }),
    ).toEqual({ droppedDatabase: false, droppedRole: false });
  });

  it("terminates live backends so the drop cannot be blocked", async () => {
    const name = track(tenantName());
    const result = await service.create({ cellDsn: CLUSTER_DSN, dbName: name });
    if (result.alreadyExists) throw new Error("expected a fresh create");

    const held = postgres(result.dsn, { max: 1, idle_timeout: 0 });
    await held.unsafe("SELECT 1");
    try {
      expect(
        await service.drop({
          cellDsn: CLUSTER_DSN,
          dbName: name,
          confirm: name,
        }),
      ).toEqual({ droppedDatabase: true, droppedRole: true });
    } finally {
      await held.end({ timeout: 5 }).catch(() => {});
    }
  });
});
