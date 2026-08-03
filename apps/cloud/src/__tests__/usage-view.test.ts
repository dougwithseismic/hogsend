import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, environments, organizations, stacks } from "../db/schema";
import { env } from "../env";
import { upgradesFrom } from "../lib/plan-catalog";
import { OrgService } from "../services/orgs";
import {
  readUsageView,
  upsertUsageCounter,
  usageMonth,
  usagePeriod,
} from "../services/usage";

/**
 * The read model behind the Usage page and the overage banner.
 *
 * Against the real database, because every rule here is about a JOIN: an
 * environment with no counter yet must read as zero rather than disappear, and
 * "over the cap" is a statement about a SUM over every environment's rows for
 * every month in the plan's billing window.
 */

const CELL = "usage-view-us-1";
const ORG = "usage-view-org";
const OTHER_ORG = "usage-view-other-org";
const ORG_IDS = [ORG, OTHER_ORG];

const orgs = new OrgService(db);

const NOW = new Date("2026-05-10T00:00:00.000Z");
const MONTH = usageMonth(NOW);

/**
 * The production environment `OrgService.create` already minted. Reused rather
 * than seeded beside: an org has exactly one production environment (PRD 02),
 * so a second would be a fixture that no signup could produce.
 */
async function productionOf(organizationId: string): Promise<string> {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.organizationId, organizationId));
  if (!row) throw new Error(`no production environment for ${organizationId}`);
  return row.id;
}

/** An extra non-production environment, with a stack of its own. */
async function seedStaging(organizationId: string): Promise<string> {
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId,
      name: `staging-${randomUUID().slice(0, 8)}`,
      kind: "staging",
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");
  await db.insert(stacks).values({
    id: randomUUID(),
    organizationId,
    environmentId: environment.id,
    status: "running",
    region: "us",
  });
  return environment.id;
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, ORG_IDS));
  await db.delete(cells).where(eq(cells.name, CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(cells).values({
    name: CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 50,
  });
});

beforeEach(async () => {
  await db.delete(organizations).where(inArray(organizations.id, ORG_IDS));
  await orgs.create({ id: ORG, name: "Usage View", region: "us" });
  await orgs.create({ id: OTHER_ORG, name: "Other", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("usagePeriod", () => {
  it("is the UTC calendar month, half-open", () => {
    const period = usagePeriod(new Date("2026-12-31T23:59:59.999Z"));
    expect(period.month).toBe("2026-12");
    expect(period.since.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    // Rolls the YEAR, not just the month.
    expect(period.until.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("readUsageView", () => {
  it("reports zero for an environment that has never been swept", async () => {
    const production = await productionOf(ORG);

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    // Present, and honestly empty. Absent would look like a deleted
    // environment.
    expect(
      view.environments.find((row) => row.environmentId === production),
    ).toMatchObject({ events: 0, emails: 0 });
    expect(view.totalEvents).toBe(0);
    expect(view.overEvents).toBe(false);
  });

  it("sums EVERY environment, and lists them", async () => {
    const production = await productionOf(ORG);
    const staging = await seedStaging(ORG);
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: production,
      month: MONTH,
      events: 400,
      emails: 40,
    });
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: staging,
      month: MONTH,
      events: 9_000,
      emails: 100,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.environments).toHaveLength(2);
    // Staging counts. A cap measured on production alone would be a bypass one
    // SDK base-URL change wide.
    expect(view.totalEvents).toBe(9_400);
    expect(view.totalEmails).toBe(140);
    expect(view.overEvents).toBe(false);
  });

  it("marks the caps breached once a staging environment carries the org past the limit", async () => {
    const staging = await seedStaging(ORG);
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: staging,
      month: MONTH,
      events: 10_001,
      emails: 0,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.overEvents).toBe(true);
  });

  it("marks the caps breached once production passes the plan limit", async () => {
    const production = await productionOf(ORG);
    // Trial: 10k events, 1k emails (DECISIONS §2).
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: production,
      month: MONTH,
      events: 10_001,
      emails: 1_001,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.overEvents).toBe(true);
    expect(view.overEmails).toBe(true);
    expect(view.limits).toMatchObject({
      eventsPerMonth: 10_000,
      emailsPerMonth: 1_000,
    });
  });

  it("reads a PAID plan's current month only — last month's overage is history", async () => {
    const production = await productionOf(ORG);
    await db
      .update(organizations)
      .set({ plan: "self_serve", trialEndsAt: null })
      .where(eq(organizations.id, ORG));
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: production,
      month: "2026-04",
      events: 500_000,
      emails: 0,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.month).toBe("2026-05");
    expect(view.months).toEqual(["2026-05"]);
    expect(view.totalEvents).toBe(0);
    expect(view.overEvents).toBe(false);
  });

  it("reads a TRIAL over its whole window, month boundary and all", async () => {
    const production = await productionOf(ORG);
    // A trial that started on 20 April: the 1st of May is not a fresh
    // allowance, because the trial's cap is a total for the 14 days.
    await db
      .update(organizations)
      .set({ createdAt: new Date("2026-04-20T00:00:00.000Z") })
      .where(eq(organizations.id, ORG));
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: production,
      month: "2026-04",
      events: 9_000,
      emails: 0,
    });
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: production,
      month: MONTH,
      events: 2_000,
      emails: 0,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.months).toEqual(["2026-04", "2026-05"]);
    expect(view.totalEvents).toBe(11_000);
    expect(view.overEvents).toBe(true);
    // Still ONE environment row — the months are folded, not listed twice.
    expect(view.environments).toHaveLength(1);
    expect(view.environments[0]?.events).toBe(11_000);
  });

  it("never reads another organization's counters", async () => {
    const mine = await productionOf(ORG);
    const theirs = await productionOf(OTHER_ORG);
    await upsertUsageCounter({
      organizationId: ORG,
      environmentId: mine,
      month: MONTH,
      events: 10,
      emails: 1,
    });
    await upsertUsageCounter({
      organizationId: OTHER_ORG,
      environmentId: theirs,
      month: MONTH,
      events: 5_000_000,
      emails: 5_000_000,
    });

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.environments).toHaveLength(1);
    expect(view.totalEvents).toBe(10);
  });

  it("counts the trial's remaining days down to zero, never below", async () => {
    await db
      .update(organizations)
      .set({ trialEndsAt: new Date("2026-05-13T00:00:00.000Z") })
      .where(eq(organizations.id, ORG));
    expect(
      (await readUsageView({ organizationId: ORG, now: NOW })).trialDaysLeft,
    ).toBe(3);

    await db
      .update(organizations)
      .set({ trialEndsAt: new Date("2026-04-01T00:00:00.000Z") })
      .where(eq(organizations.id, ORG));
    expect(
      (await readUsageView({ organizationId: ORG, now: NOW })).trialDaysLeft,
    ).toBe(0);
  });

  it("surfaces a paused ingest from the stack marker", async () => {
    const production = await productionOf(ORG);
    await db
      .update(stacks)
      .set({ ingestSuspendedAt: NOW })
      .where(eq(stacks.environmentId, production));

    const view = await readUsageView({ organizationId: ORG, now: NOW });

    expect(view.ingestSuspended).toBe(true);
  });
});

describe("upgradesFrom", () => {
  it("offers both paid tiers on trial, only dedicated on self-serve, none above", () => {
    expect(upgradesFrom("trial")).toEqual(["self_serve", "dedicated"]);
    expect(upgradesFrom("self_serve")).toEqual(["dedicated"]);
    // Downgrades are the provider portal's job, not a button here.
    expect(upgradesFrom("dedicated")).toEqual([]);
  });
});
