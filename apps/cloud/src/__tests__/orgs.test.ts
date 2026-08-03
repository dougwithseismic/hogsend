import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloudDb } from "../db";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { IllegalRegionError, NotFoundError } from "../services/errors";
import { OrgService } from "../services/orgs";

/**
 * Against a REAL database: placement counts tenants with a SQL aggregate and
 * the trio is created in ONE transaction, so a mocked driver would prove
 * neither the capacity rule nor the rollback this suite exists to pin.
 */
const US_CELL = "orgs-test-us-1";
const EU_CELL = "orgs-test-eu-1";
const ORG_IDS = [
  "orgs-test-eu-refused",
  "orgs-test-trial",
  "orgs-test-self-serve",
  "orgs-test-dedicated",
  "orgs-test-eu-first",
  "orgs-test-eu-second",
  "orgs-test-rollback",
];

const service = new OrgService(db);

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, ORG_IDS));
  await db.delete(cells).where(inArray(cells.name, [US_CELL, EU_CELL]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

/**
 * The real pool and the real transaction — only the `insert(stacks)` call is
 * swapped for a throw, so the rollback under test is Postgres', not a fake's.
 */
function dbFailingOnStackInsert(): CloudDb {
  // biome-ignore lint/suspicious/noExplicitAny: a deliberate driver-level stub
  const proxyTx = (tx: any) =>
    new Proxy(tx, {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      get(target: any, prop: string | symbol) {
        if (prop === "insert") {
          // biome-ignore lint/suspicious/noExplicitAny: see above
          return (table: any) => {
            if (table === stacks) {
              throw new Error("boom: substrate row rejected");
            }
            return target.insert(table);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    // biome-ignore lint/suspicious/noExplicitAny: see above
    get(target: any, prop: string | symbol) {
      if (prop === "transaction") {
        // biome-ignore lint/suspicious/noExplicitAny: see above
        return (cb: any) => target.transaction((tx: any) => cb(proxyTx(tx)));
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as CloudDb;
}

async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, organizationId))
    .orderBy(cloudAuditLog.createdAt);
  return rows.map((r) => r.action);
}

describe("OrgService.create", () => {
  it("refuses a shared-tier region with no accepting cell, and inserts NOTHING", async () => {
    await expect(
      service.create({
        id: "orgs-test-eu-refused",
        name: "EU Refused",
        region: "eu",
        plan: "trial",
      }),
    ).rejects.toBeInstanceOf(IllegalRegionError);

    // The whole trio must have rolled back — including the audit row.
    expect(
      await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, "orgs-test-eu-refused")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.organizationId, "orgs-test-eu-refused")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(stacks)
        .where(eq(stacks.organizationId, "orgs-test-eu-refused")),
    ).toHaveLength(0);
    expect(await auditActions("orgs-test-eu-refused")).toEqual([]);
  });

  it("creates org + production environment + requested stack atomically", async () => {
    await db.insert(cells).values({
      name: US_CELL,
      region: "us",
      sharedClusterDsn: "v1:fake-dsn",
      sharedHatchetUrl: "http://hatchet.test:7077",
      maxTenants: 5,
    });

    const result = await service.create({
      id: "orgs-test-trial",
      name: "Trial Org",
      region: "us",
      plan: "trial",
      actor: "user_test",
    });

    // A landing cell, in the org's own region. (The exact cell is not asserted:
    // sibling suites seed accepting US cells in the same database, and the rule
    // under test is "an accepting cell in MY region", not "that one row".)
    if (!result.organization.cellId) throw new Error("expected a landing cell");
    const [landed] = await db
      .select()
      .from(cells)
      .where(eq(cells.id, result.organization.cellId));
    expect(landed?.region).toBe("us");
    expect(landed?.accepting).toBe(true);

    expect(result.environment.kind).toBe("production");
    expect(result.environment.name).toBe("production");
    expect(result.stack.status).toBe("requested");
    expect(result.stack.region).toBe("us");
    expect(result.stack.environmentId).toBe(result.environment.id);
    // The namespace IS the stack id — a stable, collision-free tenant handle.
    expect(result.stack.hatchetNamespace).toBe(result.stack.id);
    expect(result.stack.dbName).toBe("hs_orgs_test_trial_production");
    expect(result.stack.dbName?.length).toBeLessThanOrEqual(63);

    // trial ⇒ a 14-day clock.
    const trialEndsAt = result.organization.trialEndsAt;
    if (!trialEndsAt) throw new Error("expected trialEndsAt on a trial org");
    const days = (trialEndsAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);

    expect(await auditActions("orgs-test-trial")).toEqual(["org.created"]);
  });

  it("leaves trial_ends_at null on a paid plan and still places it on a cell", async () => {
    const result = await service.create({
      id: "orgs-test-self-serve",
      name: "Self Serve Org",
      region: "us",
      plan: "self_serve",
    });
    expect(result.organization.trialEndsAt).toBeNull();
    expect(result.organization.cellId).not.toBeNull();
  });

  it("places a dedicated org off-cell, in ANY region", async () => {
    const result = await service.create({
      id: "orgs-test-dedicated",
      name: "Dedicated Org",
      region: "eu",
      plan: "dedicated",
    });
    expect(result.organization.cellId).toBeNull();
    expect(result.organization.region).toBe("eu");
    expect(result.stack.region).toBe("eu");
  });

  it("rolls the org and environment back when the STACK insert fails", async () => {
    // The placement failure above rejects before any INSERT, so it cannot prove
    // the transaction. This does: the org and its environment are already
    // written when the stack write blows up, and both must disappear.
    await expect(
      new OrgService(dbFailingOnStackInsert()).create({
        id: "orgs-test-rollback",
        name: "Rollback Org",
        region: "us",
        plan: "trial",
      }),
    ).rejects.toThrow("substrate row rejected");

    expect(
      await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, "orgs-test-rollback")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.organizationId, "orgs-test-rollback")),
    ).toHaveLength(0);
  });

  it("respects cell capacity: a maxTenants=1 cell fills after one org", async () => {
    await db.insert(cells).values({
      name: EU_CELL,
      region: "eu",
      sharedClusterDsn: "v1:fake-dsn",
      sharedHatchetUrl: "http://hatchet.test:7077",
      maxTenants: 1,
    });

    const first = await service.create({
      id: "orgs-test-eu-first",
      name: "EU First",
      region: "eu",
      plan: "trial",
    });
    expect(first.organization.cellId).not.toBeNull();

    await expect(
      service.create({
        id: "orgs-test-eu-second",
        name: "EU Second",
        region: "eu",
        plan: "trial",
      }),
    ).rejects.toBeInstanceOf(IllegalRegionError);
  });

  it("skips a drained cell even when it has capacity", async () => {
    // Free the EU cell's only slot, then drain it: capacity is no longer the
    // reason a placement can fail, `accepting` is.
    await db
      .delete(organizations)
      .where(eq(organizations.id, "orgs-test-eu-first"));
    await db
      .update(cells)
      .set({ accepting: false })
      .where(eq(cells.name, EU_CELL));

    await expect(
      service.create({
        id: "orgs-test-eu-second",
        name: "Drained",
        region: "eu",
        plan: "trial",
      }),
    ).rejects.toBeInstanceOf(IllegalRegionError);
  });
});

describe("OrgService reads + suspension", () => {
  it("gets an org with its environments, and reports a missing one", async () => {
    const found = await service.get({ id: "orgs-test-trial" });
    if (!found.found) throw new Error("expected the trial org");
    expect(found.organization.name).toBe("Trial Org");
    expect(found.environments.map((e) => e.name)).toEqual(["production"]);

    expect(await service.get({ id: "orgs-test-missing" })).toEqual({
      found: false,
    });
  });

  it("suspends and unsuspends, auditing each move", async () => {
    const suspended = await service.suspend({
      id: "orgs-test-trial",
      actor: "ops",
    });
    expect(suspended.organization.suspendedAt).toBeInstanceOf(Date);

    const unsuspended = await service.unsuspend({ id: "orgs-test-trial" });
    expect(unsuspended.organization.suspendedAt).toBeNull();

    expect(await auditActions("orgs-test-trial")).toEqual([
      "org.created",
      "org.suspended",
      "org.unsuspended",
    ]);
  });

  it("throws NotFoundError when suspending an org that does not exist", async () => {
    await expect(
      service.suspend({ id: "orgs-test-missing" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a malformed input before touching the database", async () => {
    await expect(
      service.create({
        id: "orgs-test-trial",
        name: "Bad Region",
        // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
        region: "apac" as any,
        plan: "trial",
      }),
    ).rejects.toThrow();
  });
});
