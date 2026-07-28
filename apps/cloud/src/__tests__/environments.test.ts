import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { EnvironmentService } from "../services/environments";
import {
  DuplicateNameError,
  DuplicateProductionError,
  NotFoundError,
  PlanLimitError,
  ProductionRemovalError,
  StackNotRemovableError,
} from "../services/errors";
import { OrgService } from "../services/orgs";

const CELL_NAME = "environments-test-us-1";
const TRIAL_ORG = "environments-test-trial";
const SELF_SERVE_ORG = "environments-test-self-serve";
/** Dedicated (4 environments) so the NAME rule can be tested clear of the
 * allowance rule, which would otherwise refuse first. */
const DEDICATED_ORG = "environments-test-dedicated";

const orgs = new OrgService(db);
const service = new EnvironmentService(db);

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(
      inArray(organizations.id, [TRIAL_ORG, SELF_SERVE_ORG, DEDICATED_ORG]),
    );
  await db.delete(cells).where(eq(cells.name, CELL_NAME));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  await db.insert(cells).values({
    name: CELL_NAME,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  await orgs.create({
    id: TRIAL_ORG,
    name: "Trial Org",
    region: "us",
    plan: "trial",
  });
  await orgs.create({
    id: SELF_SERVE_ORG,
    name: "Self Serve Org",
    region: "us",
    plan: "self_serve",
  });
  await orgs.create({
    id: DEDICATED_ORG,
    name: "Dedicated Org",
    region: "us",
    plan: "dedicated",
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, organizationId))
    .orderBy(cloudAuditLog.createdAt);
  return rows.map((r) => r.action);
}

describe("EnvironmentService.create", () => {
  it("refuses a second production and creates nothing", async () => {
    await expect(
      service.create({
        organizationId: SELF_SERVE_ORG,
        name: "prod-2",
        kind: "production",
      }),
    ).rejects.toBeInstanceOf(DuplicateProductionError);

    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.organizationId, SELF_SERVE_ORG)),
    ).toHaveLength(1);
  });

  it("refuses a second environment of ANY kind on the trial plan", async () => {
    await expect(
      service.create({
        organizationId: TRIAL_ORG,
        name: "staging",
        kind: "staging",
      }),
    ).rejects.toBeInstanceOf(PlanLimitError);

    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.organizationId, TRIAL_ORG)),
    ).toHaveLength(1);
  });

  it("allows a self-serve org exactly two environments, with a requested stack", async () => {
    const created = await service.create({
      organizationId: SELF_SERVE_ORG,
      name: "staging",
      kind: "staging",
      actor: "user_test",
    });

    expect(created.environment.kind).toBe("staging");
    expect(created.stack.status).toBe("requested");
    expect(created.stack.region).toBe("us");
    expect(created.stack.hatchetNamespace).toBe(created.stack.id);
    expect(created.stack.dbName).toBe(
      "hs_environments_test_self_serve_staging",
    );

    await expect(
      service.create({
        organizationId: SELF_SERVE_ORG,
        name: "test",
        kind: "test",
      }),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it("surfaces the unique-name constraint as a typed error", async () => {
    await service.create({
      organizationId: DEDICATED_ORG,
      name: "staging",
      kind: "staging",
    });

    await expect(
      service.create({
        organizationId: DEDICATED_ORG,
        name: "staging",
        kind: "test",
      }),
    ).rejects.toBeInstanceOf(DuplicateNameError);

    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.organizationId, DEDICATED_ORG)),
    ).toHaveLength(2);
  });

  it("reports an unknown organization", async () => {
    await expect(
      service.create({
        organizationId: "environments-test-missing",
        name: "staging",
        kind: "staging",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("EnvironmentService.list", () => {
  it("joins each environment to its stack status", async () => {
    const { environments: rows } = await service.list({
      organizationId: SELF_SERVE_ORG,
    });
    expect(rows.map((r) => r.name)).toEqual(["production", "staging"]);
    for (const row of rows) {
      expect(row.stack?.status).toBe("requested");
    }
  });
});

describe("EnvironmentService.remove", () => {
  it("refuses to remove production", async () => {
    const [production] = await db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, SELF_SERVE_ORG))
      .orderBy(environments.name);
    if (!production) throw new Error("expected the production environment");

    await expect(
      service.remove({
        organizationId: SELF_SERVE_ORG,
        environmentId: production.id,
      }),
    ).rejects.toBeInstanceOf(ProductionRemovalError);

    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.id, production.id)),
    ).toHaveLength(1);
  });

  it("refuses to remove an environment whose stack is live", async () => {
    const [staging] = await db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.organizationId, SELF_SERVE_ORG),
          eq(environments.name, "staging"),
        ),
      );
    if (!staging) throw new Error("expected the staging environment");

    // Simulated by hand: the state machine (task 4) is the only legal writer.
    await db
      .update(stacks)
      .set({ status: "running" })
      .where(eq(stacks.environmentId, staging.id));

    await expect(
      service.remove({
        organizationId: SELF_SERVE_ORG,
        environmentId: staging.id,
      }),
    ).rejects.toBeInstanceOf(StackNotRemovableError);
  });

  it("removes a pre-provision environment and audits it", async () => {
    const [staging] = await db
      .select()
      .from(environments)
      .where(
        and(
          eq(environments.organizationId, SELF_SERVE_ORG),
          eq(environments.name, "staging"),
        ),
      );
    if (!staging) throw new Error("expected the staging environment");

    await db
      .update(stacks)
      .set({ status: "destroyed" })
      .where(eq(stacks.environmentId, staging.id));

    const removed = await service.remove({
      organizationId: SELF_SERVE_ORG,
      environmentId: staging.id,
      actor: "ops",
    });
    expect(removed.removed).toBe(true);

    expect(
      await db
        .select()
        .from(environments)
        .where(eq(environments.id, staging.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(stacks)
        .where(eq(stacks.environmentId, staging.id)),
    ).toHaveLength(0);

    expect(await auditActions(SELF_SERVE_ORG)).toEqual([
      "org.created",
      "environment.created",
      "environment.removed",
    ]);
  });

  it("reports a missing environment, and refuses a cross-org id", async () => {
    await expect(
      service.remove({
        organizationId: SELF_SERVE_ORG,
        environmentId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [trialProd] = await db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, TRIAL_ORG));
    if (!trialProd) throw new Error("expected the trial production env");

    await expect(
      service.remove({
        organizationId: SELF_SERVE_ORG,
        environmentId: trialProd.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
