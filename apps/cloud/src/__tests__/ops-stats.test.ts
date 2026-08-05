import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { GET as statsGET } from "../../app/api/ops/stats/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  builds,
  environments,
  organizations,
  stackAlerts,
  stackHealth,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { readOpsStats } from "../lib/ops-stats";

/**
 * The fleet-stats read and its route shell, against the REAL control-plane
 * database.
 *
 * The read is fleet-GLOBAL by design, so each test starts from an empty
 * `organizations` table (everything else cascades from it) — the same global
 * wipe `health-poll.test.ts` uses, and for the same reason: a leftover row
 * from another suite would silently inflate a count assertion.
 */

const OPS_TOKEN = "ops-stats-test-token-0123456789abcdef";

function statsRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://cloud.test/api/ops/stats", { headers });
}

interface SeedInput {
  status: (typeof stacks.status.enumValues)[number];
  plan?: "trial" | "self_serve" | "dedicated";
  lastError?: string;
  retryCount?: number;
}

async function seedStack(input: SeedInput) {
  const orgId = `ops-stats-org-${randomBytes(6).toString("hex")}`;
  await db.insert(organizations).values({
    id: orgId,
    name: "Ops Stats Test",
    region: "us",
    plan: input.plan ?? "self_serve",
  });
  const [environment] = await db
    .insert(environments)
    .values({ organizationId: orgId, name: "production", kind: "production" })
    .returning();
  if (!environment) throw new Error("fixture environment not created");
  const stackId = randomUUID();
  await db.insert(stacks).values({
    id: stackId,
    organizationId: orgId,
    environmentId: environment.id,
    status: input.status,
    lastError: input.lastError,
    retryCount: input.retryCount ?? 0,
    region: "us",
    substrateRefs: {},
  });
  return { orgId, environmentId: environment.id, stackId };
}

async function observe(
  stackId: string,
  orgId: string,
  healthy: boolean,
  at: Date,
): Promise<void> {
  await db.insert(stackHealth).values({
    stackId,
    organizationId: orgId,
    healthy,
    detail: healthy ? null : "http 500",
    checkedAt: at,
  });
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
});

beforeEach(async () => {
  await db.delete(organizations);
});

afterEach(() => {
  delete process.env.CLOUD_OPS_TOKEN;
});

afterAll(async () => {
  await db.delete(organizations);
  await sqlClient.end();
});

describe("GET /api/ops/stats auth", () => {
  it("is 404 when no token is configured, even with a bearer", async () => {
    const response = await statsGET(
      statsRequest({ authorization: `Bearer ${OPS_TOKEN}` }),
    );
    expect(response.status).toBe(404);
  });

  it("is 401 on a missing or wrong bearer", async () => {
    process.env.CLOUD_OPS_TOKEN = OPS_TOKEN;
    expect((await statsGET(statsRequest())).status).toBe(401);
    expect(
      (await statsGET(statsRequest({ authorization: "Bearer nope" }))).status,
    ).toBe(401);
  });

  it("returns the stats payload on the right bearer", async () => {
    process.env.CLOUD_OPS_TOKEN = OPS_TOKEN;
    const response = await statsGET(
      statsRequest({ authorization: `Bearer ${OPS_TOKEN}` }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "builds",
      "generatedAt",
      "health",
      "openAlerts",
      "organizations",
      "provisioning",
      "stacks",
    ]);
  });
});

describe("readOpsStats", () => {
  it("zero-fills every enum key on an empty fleet", async () => {
    const stats = await readOpsStats();
    expect(stats.stacks.total).toBe(0);
    expect(Object.keys(stats.stacks.byStatus).sort()).toEqual(
      [
        "destroyed",
        "destroying",
        "error",
        "provisioning",
        "publishing",
        "requested",
        "running",
        "suspended",
      ].sort(),
    );
    expect(stats.organizations.byPlan).toEqual({
      trial: 0,
      self_serve: 0,
      dedicated: 0,
    });
    expect(stats.builds).toEqual({
      active: 0,
      queued: 0,
      last24h: { succeeded: 0, failed: 0 },
    });
  });

  it("counts stacks, orgs, errors, alerts and builds from seeded state", async () => {
    const running = await seedStack({ status: "running", plan: "trial" });
    const errored = await seedStack({
      status: "error",
      lastError: "[set-env] boom",
      retryCount: 2,
    });
    await seedStack({ status: "provisioning" });

    const now = new Date("2026-08-05T12:00:00.000Z");
    await observe(running.stackId, running.orgId, true, now);

    await db.insert(stackAlerts).values({
      stackId: errored.stackId,
      organizationId: errored.orgId,
      condition: "provision_exhausted",
      fingerprint: "error:boom",
      lastAlertedAt: now,
    });

    await db.insert(builds).values([
      {
        environmentId: running.environmentId,
        status: "queued",
        artifactPath: "ops-stats-test/queued.tgz",
      },
      {
        environmentId: running.environmentId,
        status: "failed",
        artifactPath: "ops-stats-test/failed.tgz",
        finishedAt: new Date(now.getTime() - 60_000),
      },
    ]);

    const stats = await readOpsStats({ now: () => now });

    expect(stats.stacks.byStatus.running).toBe(1);
    expect(stats.stacks.byStatus.error).toBe(1);
    expect(stats.stacks.byStatus.provisioning).toBe(1);
    expect(stats.stacks.total).toBe(3);
    expect(stats.organizations.total).toBe(3);
    expect(stats.organizations.byPlan.trial).toBe(1);
    expect(stats.organizations.byPlan.self_serve).toBe(2);
    expect(stats.provisioning.inFlight).toBe(1);
    expect(stats.provisioning.errored).toEqual([
      {
        stackId: errored.stackId,
        organizationId: errored.orgId,
        lastError: "[set-env] boom",
        retryCount: 2,
      },
    ]);
    expect(stats.openAlerts).toEqual([
      { condition: "provision_exhausted", count: 1 },
    ]);
    expect(stats.health).toMatchObject({
      running: 1,
      healthy: 1,
      unhealthy: 0,
      unobserved: 0,
    });
    expect(stats.builds.queued).toBe(1);
    expect(stats.builds.active).toBe(1);
    expect(stats.builds.last24h).toEqual({ succeeded: 0, failed: 1 });
  });

  it("classifies the latest observation, not the history", async () => {
    const stack = await seedStack({ status: "running" });
    const base = new Date("2026-08-05T12:00:00.000Z");
    await observe(stack.stackId, stack.orgId, false, base);
    await observe(
      stack.stackId,
      stack.orgId,
      true,
      new Date(base.getTime() + 60_000),
    );

    const recovered = await readOpsStats();
    expect(recovered.health.healthy).toBe(1);
    expect(recovered.health.unhealthy).toBe(0);

    // A never-observed running stack is `unobserved`, not silently healthy.
    await db.delete(stackHealth);
    const unobserved = await readOpsStats();
    expect(unobserved.health.unobserved).toBe(1);
    expect(unobserved.health.healthy).toBe(0);
  });

  it("raises the streak alert through the reused getStackAlerts wiring", async () => {
    const stack = await seedStack({ status: "running" });
    const base = new Date("2026-08-05T12:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      await observe(
        stack.stackId,
        stack.orgId,
        false,
        new Date(base.getTime() + i * 60_000),
      );
    }

    const alerting = await readOpsStats();
    expect(alerting.health.alerts).toHaveLength(1);
    expect(alerting.health.alerts[0]).toMatchObject({
      stackId: stack.stackId,
      streak: 3,
    });
    expect(alerting.health.unhealthy).toBe(1);

    // One healthy observation on top clears the alert by being the newest row.
    await observe(
      stack.stackId,
      stack.orgId,
      true,
      new Date(base.getTime() + 4 * 60_000),
    );
    const cleared = await readOpsStats();
    expect(cleared.health.alerts).toHaveLength(0);
    expect(cleared.health.healthy).toBe(1);
  });
});
