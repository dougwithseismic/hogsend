import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BillingEvent, BillingPlan } from "../billing/types";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  stacks,
  usageCounters,
} from "../db/schema";
import { env } from "../env";
import { encryptSecretPayload } from "../lib/crypto";
import {
  BILLING_SWEEP_CRON,
  enforcePlanLimits,
  INGEST_RESUMED_ACTION,
  INGEST_SUSPENDED_ACTION,
  INGEST_SUSPENDED_ENV,
  runBillingSweep,
  sweepUsage,
  TRIAL_EXPIRED_ACTION,
  USAGE_SWEEP_FAILED_ACTION,
} from "../metering/sweep";
import type { TenantUsageCounts } from "../metering/tenant-usage";
import { PlanService } from "../services/billing-plan";
import { OrgService } from "../services/orgs";
import { StackService } from "../services/stacks";
import { upsertUsageCounter, usageMonth } from "../services/usage";
import type { StackRefs } from "../substrate";
import { FakeSubstrate } from "../substrate";

/**
 * Metering and enforcement, against the REAL control-plane database and
 * `FakeSubstrate`.
 *
 * The tenant reader is INJECTED rather than pointed at a second Postgres: what
 * is under test here is the sweep's bookkeeping (one counter row per stack per
 * month, absolute writes, one dead tenant never stopping the fleet) and the
 * enforcement's idempotency. `metering/tenant-usage.ts` owns the SQL and its
 * read-only posture, and is exercised separately.
 *
 * The clock is injected everywhere for the same reason as the health poll: a
 * month boundary and a trial expiry are statements about time, and a test that
 * waited for a real one would be untestable rather than merely slow.
 */

const CELL = "metering-us-1";
const TRIAL_ORG = "metering-trial-org";
const PAID_ORG = "metering-paid-org";
const EXPIRED_ORG = "metering-expired-trial-org";
const ORG_IDS = [TRIAL_ORG, PAID_ORG, EXPIRED_ORG];

const orgs = new OrgService(db);
const stackService = new StackService(db);

/** Mid-month, so the period window is unambiguous in both directions. */
const NOW = new Date("2026-03-15T02:00:00.000Z");
const MONTH = usageMonth(NOW);
/** The following month — the "cap resets" clock. */
const NEXT_MONTH_NOW = new Date("2026-04-02T02:00:00.000Z");

const TENANT_DSN = "postgres://tenant:secret@cell.internal:5432/hs_tenant";

interface Fixture {
  environmentId: string;
  stackId: string;
  refs: StackRefs;
}

let substrate: FakeSubstrate;
/** stackId → what the injected reader reports for that stack's tenant DB. */
let readings: Map<string, TenantUsageCounts | Error>;

function reader() {
  return async ({ dsn }: { dsn: string }): Promise<TenantUsageCounts> => {
    const reading = readings.get(dsn);
    if (!reading) throw new Error(`no scripted reading for ${dsn}`);
    if (reading instanceof Error) throw reading;
    return reading;
  };
}

/** The DSN a fixture stack stores — unique per stack so the reader can key on
 * it exactly as the real one would (one DSN, one tenant database). */
function dsnFor(stackId: string): string {
  return `${TENANT_DSN}_${stackId.slice(0, 8)}`;
}

async function seedStack(
  organizationId: string,
  kind: "production" | "staging",
  options: { dsn?: string | null; running?: boolean } = {},
): Promise<Fixture> {
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId,
      name: `${kind}-${randomUUID().slice(0, 8)}`,
      kind,
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const refs = await substrate.provisionStack({
    stackId,
    organizationId,
    environmentName: environment.name,
    region: "us",
    topology: "shared",
    initialImage: "hogsend-default:test",
    env: {},
  });

  const dsn = options.dsn === undefined ? dsnFor(stackId) : options.dsn;
  await db.insert(stacks).values({
    id: stackId,
    organizationId,
    environmentId: environment.id,
    status: "requested",
    region: "us",
    substrateRefs: { ...refs },
    ...(dsn ? { dbDsnEncrypted: encryptSecretPayload(dsn) } : {}),
  });

  await stackService.transition({ stackId, to: "provisioning" });
  if (options.running !== false) {
    await stackService.transition({ stackId, to: "running" });
  }

  return { environmentId: environment.id, stackId, refs };
}

async function readCounter(environmentId: string, month = MONTH) {
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.environmentId, environmentId),
        eq(usageCounters.month, month),
      ),
    );
  return row;
}

async function readStack(stackId: string) {
  const [row] = await db.select().from(stacks).where(eq(stacks.id, stackId));
  if (!row) throw new Error(`missing stack ${stackId}`);
  return row;
}

async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, organizationId));
  return rows.map((row) => row.action).sort();
}

/** Substrate calls made against ONE stack, by method name. */
function callsFor(refs: StackRefs, method: string): unknown[][] {
  return substrate.calls
    .filter(
      (call) =>
        call.method === method &&
        (call.args[0] as StackRefs | undefined)?.apiPublicUrl ===
          refs.apiPublicUrl,
    )
    .map((call) => call.args);
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
  substrate = new FakeSubstrate();
  readings = new Map();
  // Orgs (and their cascading environments, stacks and counters) are rebuilt
  // per test: the sweep is fleet-wide by design, so a leftover stack from an
  // earlier test would be swept by a later one.
  await db.delete(organizations).where(inArray(organizations.id, ORG_IDS));
  await orgs.create({ id: TRIAL_ORG, name: "Metering Trial", region: "us" });
  await orgs.create({
    id: PAID_ORG,
    name: "Metering Paid",
    region: "us",
    plan: "self_serve",
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("sweepUsage", () => {
  it("writes one counter per running stack for the current UTC month", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    const staging = await seedStack(TRIAL_ORG, "staging");
    readings.set(dsnFor(production.stackId), { events: 4_200, emails: 310 });
    readings.set(dsnFor(staging.stackId), { events: 17, emails: 0 });

    const result = await sweepUsage({
      substrate,
      readTenantUsage: reader(),
      now: () => NOW,
    });

    expect(result.month).toBe("2026-03");
    const mine = result.counters.filter((row) =>
      [production.stackId, staging.stackId].includes(row.stackId),
    );
    expect(mine).toHaveLength(2);

    expect(await readCounter(production.environmentId)).toMatchObject({
      eventsCount: 4_200,
      emailsCount: 310,
      organizationId: TRIAL_ORG,
    });
    expect(await readCounter(staging.environmentId)).toMatchObject({
      eventsCount: 17,
      emailsCount: 0,
    });
  });

  it("counts the tenant's own calendar month window, not a rolling one", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    let window: { since: Date; until: Date } | undefined;
    readings.set(dsnFor(production.stackId), { events: 1, emails: 1 });

    await sweepUsage({
      substrate,
      now: () => NOW,
      readTenantUsage: async (input) => {
        window = { since: input.since, until: input.until };
        return { events: 1, emails: 1 };
      },
    });

    expect(window?.since.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(window?.until.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("SETS the counter rather than adding to it, so a re-run is a no-op", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    readings.set(dsnFor(production.stackId), { events: 900, emails: 12 });

    const deps = { substrate, readTenantUsage: reader(), now: () => NOW };
    await sweepUsage(deps);
    await sweepUsage(deps);

    expect(await readCounter(production.environmentId)).toMatchObject({
      eventsCount: 900,
      emailsCount: 12,
    });
  });

  it("records a failure for an unreachable tenant and sweeps the rest anyway", async () => {
    const broken = await seedStack(TRIAL_ORG, "production");
    const healthy = await seedStack(PAID_ORG, "production");
    readings.set(
      dsnFor(broken.stackId),
      new Error("connect ECONNREFUSED cell.internal:5432"),
    );
    readings.set(dsnFor(healthy.stackId), { events: 5, emails: 5 });

    const result = await sweepUsage({
      substrate,
      readTenantUsage: reader(),
      now: () => NOW,
    });

    const failure = result.failed.find((row) => row.stackId === broken.stackId);
    expect(failure?.reason).toContain("ECONNREFUSED");
    expect(await readCounter(broken.environmentId)).toBeUndefined();
    // The point of the test: the fleet did not stop at the dead tenant.
    expect(await readCounter(healthy.environmentId)).toMatchObject({
      eventsCount: 5,
    });
    expect(await auditActions(TRIAL_ORG)).toContain(USAGE_SWEEP_FAILED_ACTION);
  });

  it("records a failure for a running stack with no stored tenant DSN", async () => {
    const dsnless = await seedStack(TRIAL_ORG, "production", { dsn: null });

    const result = await sweepUsage({
      substrate,
      readTenantUsage: reader(),
      now: () => NOW,
    });

    expect(
      result.failed.find((row) => row.stackId === dsnless.stackId)?.reason,
    ).toMatch(/tenant/i);
    expect(await readCounter(dsnless.environmentId)).toBeUndefined();
  });

  it("closes the previous month on the first sweeps after the 1st", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    const windows: string[] = [];

    // 03:00 on the 1st: the cron's own hour. March's counter was last written
    // at 03:00 on the 31st, so its final 21 hours exist only if this run
    // re-closes it.
    const result = await sweepUsage({
      substrate,
      now: () => new Date("2026-04-01T03:00:00.000Z"),
      readTenantUsage: async (input) => {
        windows.push(input.since.toISOString());
        return { events: 7, emails: 1 };
      },
    });

    expect(result.month).toBe("2026-04");
    expect(result.months).toEqual(["2026-04", "2026-03"]);
    expect(windows).toContain("2026-03-01T00:00:00.000Z");
    expect(
      await readCounter(production.environmentId, "2026-03"),
    ).toMatchObject({ eventsCount: 7, emailsCount: 1 });
    expect(
      await readCounter(production.environmentId, "2026-04"),
    ).toMatchObject({ eventsCount: 7, emailsCount: 1 });
  });

  it("meters the current month only once the boundary is well behind", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    readings.set(dsnFor(production.stackId), { events: 3, emails: 0 });

    const result = await sweepUsage({
      substrate,
      readTenantUsage: reader(),
      now: () => NOW,
    });

    expect(result.months).toEqual([MONTH]);
    expect(
      await readCounter(production.environmentId, "2026-02"),
    ).toBeUndefined();
  });

  it("never opens a tenant connection for a stack that is not running", async () => {
    const pending = await seedStack(TRIAL_ORG, "production", {
      running: false,
    });
    const opened: string[] = [];

    const result = await sweepUsage({
      substrate,
      now: () => NOW,
      readTenantUsage: async (input) => {
        opened.push(input.dsn);
        return { events: 0, emails: 0 };
      },
    });

    expect(opened).not.toContain(dsnFor(pending.stackId));
    expect(result.counters.map((row) => row.stackId)).not.toContain(
      pending.stackId,
    );
  });
});

describe("enforcePlanLimits", () => {
  it("suspends ingest on a production stack whose org is over the event cap", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    // Trial: 10k events (DECISIONS §2).
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 10_001,
      emails: 0,
    });

    const result = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      result.actions.find((row) => row.stackId === production.stackId),
    ).toMatchObject({ verdict: "ingest_suspended" });
    expect(
      substrate.snapshot(production.refs).env.api[INGEST_SUSPENDED_ENV],
    ).toBe("true");
    expect(callsFor(production.refs, "redeploy")).toHaveLength(1);
    expect((await readStack(production.stackId)).ingestSuspendedAt).not.toBe(
      null,
    );
    expect(await auditActions(TRIAL_ORG)).toContain(INGEST_SUSPENDED_ACTION);
  });

  it("suspends ingest on an over-EMAIL-cap org too", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 0,
      emails: 1_001,
    });

    await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      substrate.snapshot(production.refs).env.api[INGEST_SUSPENDED_ENV],
    ).toBe("true");
  });

  it("does not re-set or re-deploy a stack that is already suspended", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 20_000,
      emails: 0,
    });

    await enforcePlanLimits({ substrate, now: () => NOW });
    const second = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      second.actions.filter((row) => row.stackId === production.stackId),
    ).toHaveLength(0);
    // One setEnv and one redeploy across BOTH runs: a nightly sweep must not
    // restart a tenant's instance every night for a cap that is still breached.
    expect(callsFor(production.refs, "setEnv")).toHaveLength(1);
    expect(callsFor(production.refs, "redeploy")).toHaveLength(1);
  });

  it("lifts a PAID plan's flag when the new month's counter is under the cap", async () => {
    const production = await seedStack(PAID_ORG, "production");
    await upsertUsageCounter({
      organizationId: PAID_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 200_000,
      emails: 0,
    });
    await enforcePlanLimits({ substrate, now: () => NOW });

    // A new calendar month: the March counter is history and April has none.
    const result = await enforcePlanLimits({
      substrate,
      now: () => NEXT_MONTH_NOW,
    });

    expect(
      result.actions.find((row) => row.stackId === production.stackId),
    ).toMatchObject({ verdict: "ingest_resumed" });
    expect(
      substrate.snapshot(production.refs).env.api[INGEST_SUSPENDED_ENV],
    ).toBeUndefined();
    expect((await readStack(production.stackId)).ingestSuspendedAt).toBe(null);
    expect(await auditActions(PAID_ORG)).toContain(INGEST_RESUMED_ACTION);
  });

  it("keeps a TRIAL suspended across the 1st — its cap is the whole 14 days", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    // A trial that started on the 20th of March: 10k is the total for the
    // whole window, so April must not hand out a second free allowance.
    await db
      .update(organizations)
      .set({
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        trialEndsAt: new Date("2026-04-03T00:00:00.000Z"),
      })
      .where(eq(organizations.id, TRIAL_ORG));
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: "2026-03",
      events: 20_000,
      emails: 0,
    });
    await enforcePlanLimits({
      substrate,
      now: () => new Date("2026-03-25T02:00:00.000Z"),
    });
    expect((await readStack(production.stackId)).ingestSuspendedAt).not.toBe(
      null,
    );

    // The 1st has passed and April's counter is empty. The trial's window
    // still carries March, so nothing is lifted.
    const result = await enforcePlanLimits({
      substrate,
      now: () => new Date("2026-04-02T02:00:00.000Z"),
    });

    expect(
      result.actions.filter((row) => row.stackId === production.stackId),
    ).toHaveLength(0);
    expect(
      substrate.snapshot(production.refs).env.api[INGEST_SUSPENDED_ENV],
    ).toBe("true");
    expect((await readStack(production.stackId)).ingestSuspendedAt).not.toBe(
      null,
    );
  });

  it("lifts the flag when the plan is upgraded past the same usage", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 12_000,
      emails: 0,
    });
    await enforcePlanLimits({ substrate, now: () => NOW });

    // 12k events is over trial's 10k and well under self-serve's 100k.
    await db
      .update(organizations)
      .set({ plan: "self_serve", trialEndsAt: null })
      .where(eq(organizations.id, TRIAL_ORG));

    const result = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      result.actions.find((row) => row.stackId === production.stackId),
    ).toMatchObject({ verdict: "ingest_resumed" });
    expect((await readStack(production.stackId)).ingestSuspendedAt).toBe(null);
  });

  it("counts EVERY environment and flags every running stack", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    const staging = await seedStack(TRIAL_ORG, "staging");
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 100,
      emails: 0,
    });
    // The bypass this pins shut: ingest against staging is ingest against the
    // plan. Extra environments are part of the tier, not extra allowance.
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: staging.environmentId,
      month: MONTH,
      events: 10_000,
      emails: 0,
    });

    const result = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      result.actions
        .filter((row) =>
          [production.stackId, staging.stackId].includes(row.stackId),
        )
        .map((row) => row.verdict),
    ).toEqual(["ingest_suspended", "ingest_suspended"]);
    expect((await readStack(production.stackId)).ingestSuspendedAt).not.toBe(
      null,
    );
    expect((await readStack(staging.stackId)).ingestSuspendedAt).not.toBe(null);
    expect(substrate.snapshot(staging.refs).env.api[INGEST_SUSPENDED_ENV]).toBe(
      "true",
    );
  });

  it("suspends the stacks and the org when a trial has expired", async () => {
    await orgs.create({ id: EXPIRED_ORG, name: "Expired", region: "us" });
    const production = await seedStack(EXPIRED_ORG, "production");
    await db
      .update(organizations)
      .set({ trialEndsAt: new Date("2026-03-01T00:00:00.000Z") })
      .where(eq(organizations.id, EXPIRED_ORG));

    const result = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      result.trialsExpired.find((row) => row.organizationId === EXPIRED_ORG)
        ?.stackIds,
    ).toEqual([production.stackId]);
    expect((await readStack(production.stackId)).status).toBe("suspended");

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, EXPIRED_ORG));
    expect(org?.suspendedAt).not.toBe(null);
    // `billing` is the ONLY reason a later checkout will lift on its own.
    expect(org?.suspendedReason).toBe("billing");
    expect(await auditActions(EXPIRED_ORG)).toContain(TRIAL_EXPIRED_ACTION);
  });

  it("does not re-suspend an org whose trial already expired", async () => {
    await orgs.create({ id: EXPIRED_ORG, name: "Expired", region: "us" });
    await seedStack(EXPIRED_ORG, "production");
    await db
      .update(organizations)
      .set({ trialEndsAt: new Date("2026-03-01T00:00:00.000Z") })
      .where(eq(organizations.id, EXPIRED_ORG));

    await enforcePlanLimits({ substrate, now: () => NOW });
    const second = await enforcePlanLimits({ substrate, now: () => NOW });

    expect(
      second.trialsExpired.filter((row) => row.organizationId === EXPIRED_ORG),
    ).toHaveLength(0);
  });

  it("leaves a trial inside its window alone", async () => {
    const production = await seedStack(TRIAL_ORG, "production");

    await enforcePlanLimits({ substrate, now: () => NOW });

    expect((await readStack(production.stackId)).status).toBe("running");
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, TRIAL_ORG));
    expect(org?.suspendedAt).toBe(null);
  });
});

describe("billing recovery", () => {
  /** A completed checkout for `organizationId`, on `plan`. */
  function checkout(organizationId: string, plan: BillingPlan): BillingEvent {
    return {
      type: "checkout_completed",
      organizationId,
      plan,
      eventId: `evt_checkout_${organizationId}`,
      occurredAt: NOW,
      raw: {},
    };
  }

  it("restarts the stacks a trial expiry stopped when the checkout lands", async () => {
    await orgs.create({ id: EXPIRED_ORG, name: "Expired", region: "us" });
    const production = await seedStack(EXPIRED_ORG, "production");
    await db
      .update(organizations)
      .set({ trialEndsAt: new Date("2026-03-01T00:00:00.000Z") })
      .where(eq(organizations.id, EXPIRED_ORG));
    await enforcePlanLimits({ substrate, now: () => NOW });
    expect((await readStack(production.stackId)).status).toBe("suspended");

    const result = await new PlanService(db, { substrate }).applyBillingEvent(
      checkout(EXPIRED_ORG, "self_serve"),
      { now: NOW },
    );

    // The whole point: clearing `suspended_at` starts no container. The
    // customer paid, so the instance has to come back with it.
    expect(result.actions).toContain("org.unsuspended");
    expect(result.actions).toContain("stack.resume");
    expect((await readStack(production.stackId)).status).toBe("running");
    const snapshot = substrate.snapshot(production.refs);
    expect(snapshot.services.api.running).toBe(true);
    expect(snapshot.services.worker.running).toBe(true);
  });

  it("lifts a paused ingest on the upgrade, not at the next nightly cron", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    await upsertUsageCounter({
      organizationId: TRIAL_ORG,
      environmentId: production.environmentId,
      month: MONTH,
      events: 12_000,
      emails: 0,
    });
    await enforcePlanLimits({ substrate, now: () => NOW });
    expect((await readStack(production.stackId)).ingestSuspendedAt).not.toBe(
      null,
    );

    const result = await new PlanService(db, { substrate }).applyBillingEvent(
      checkout(TRIAL_ORG, "self_serve"),
      { now: NOW },
    );

    expect(result.actions).toContain(INGEST_RESUMED_ACTION);
    expect((await readStack(production.stackId)).ingestSuspendedAt).toBe(null);
    expect(
      substrate.snapshot(production.refs).env.api[INGEST_SUSPENDED_ENV],
    ).toBeUndefined();
  });
});

describe("BILLING_SWEEP_CRON", () => {
  it("runs once a day, at a fixed hour", () => {
    // The sweep opens a connection to EVERY tenant database. A per-minute cron
    // here — a plausible copy-paste from the health sweep — would hammer the
    // whole fleet 1,440 times a day for numbers that change once.
    const [minute, hour, dayOfMonth, month, dayOfWeek] =
      BILLING_SWEEP_CRON.split(" ");
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(["*", "*", "*"]);
  });
});

describe("runBillingSweep", () => {
  it("meters, enforces, and expires the dunning grace in one run", async () => {
    const production = await seedStack(TRIAL_ORG, "production");
    readings.set(dsnFor(production.stackId), { events: 10_500, emails: 0 });

    // A paid org 15 days into a 14-day grace — only the clock can end it.
    await db
      .update(organizations)
      .set({ dunningSince: new Date("2026-02-27T00:00:00.000Z") })
      .where(eq(organizations.id, PAID_ORG));

    const result = await runBillingSweep({
      substrate,
      readTenantUsage: reader(),
      now: () => NOW,
    });

    expect(await readCounter(production.environmentId)).toMatchObject({
      eventsCount: 10_500,
    });
    expect(
      result.enforcement.actions.find(
        (row) => row.stackId === production.stackId,
      ),
    ).toMatchObject({ verdict: "ingest_suspended" });
    expect(result.dunning.suspended).toContain(PAID_ORG);
  });
});
