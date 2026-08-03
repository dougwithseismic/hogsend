import { randomBytes, randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations, stackHealth, stacks } from "../db/schema";
import { env } from "../env";
import {
  getStackAlerts,
  sweepStackHealth,
  UNHEALTHY_ALERT_STREAK,
} from "../pipeline/health-poll";
import { StackService } from "../services/stacks";
import type { StackRefs } from "../substrate";
import { FakeSubstrate } from "../substrate";

/**
 * The health sweep and the alert rule it feeds, against the REAL control-plane
 * database and `FakeSubstrate`.
 *
 * No cell and no tenant database here on purpose: the sweep touches neither. It
 * reads `running` stacks, asks the substrate, and appends rows — so the stacks
 * are seeded straight into `running` rather than provisioned, and the test says
 * exactly what it means.
 *
 * The clock is INJECTED. Two observations written in the same millisecond would
 * order arbitrarily, and "three consecutive sweeps" is a statement about ORDER —
 * a streak test that relied on wall-clock resolution would be flaky by design.
 */

const ORG_ID = "health-poll-test-org";
const stackService = new StackService(db);

let clock = new Date("2026-01-01T00:00:00.000Z");
/** One minute per sweep — the cron's real cadence, deterministically. */
function tick(): Date {
  clock = new Date(clock.getTime() + 60_000);
  return clock;
}

interface Fixture {
  stackId: string;
  refs: StackRefs;
}

/** A `running` stack with a real FakeSubstrate stack behind its refs. */
async function seedRunningStack(substrate: FakeSubstrate): Promise<Fixture> {
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG_ID,
      name: `health-${randomBytes(4).toString("hex")}`,
      kind: "staging",
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const refs = await substrate.provisionStack({
    stackId,
    organizationId: ORG_ID,
    environmentName: environment.name,
    region: "us",
    topology: "shared",
    initialImage: "hogsend-default:test",
    env: {},
  });

  await db.insert(stacks).values({
    id: stackId,
    organizationId: ORG_ID,
    environmentId: environment.id,
    status: "requested",
    region: "us",
    substrateRefs: { ...refs },
  });
  // Through the state machine, not an UPDATE: `status` has exactly one writer.
  await stackService.transition({ stackId, to: "provisioning" });
  await stackService.transition({ stackId, to: "running" });

  return { stackId, refs };
}

async function observations(stackId: string) {
  return db
    .select()
    .from(stackHealth)
    .where(eq(stackHealth.stackId, stackId))
    .orderBy(asc(stackHealth.checkedAt));
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values({
    id: ORG_ID,
    name: "Health Poll Test",
    region: "us",
    plan: "self_serve",
  });
});

/**
 * The sweep is deliberately UNSCOPED — it visits every `running` stack there
 * is, which is the whole point of a control-plane cron. So each test starts
 * from an empty stack table (environments cascade to stacks, and stacks to
 * their health rows), and a count assertion below means what it says.
 *
 * Note the delete is GLOBAL, not scoped to `ORG_ID`. Scoping it was a latent
 * bug: a `running` stack belonging to any other org — a hand-made row left in
 * the cloud database by local development, say — is visited by the sweep like
 * any other. That inflates the count, and worse, it is NOT registered with the
 * per-test `FakeSubstrate`, so its `getHealth` throws and silently eats a
 * `failNext` script intended for one of the stacks the test actually seeded.
 */
beforeEach(async () => {
  await db.delete(environments);
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("sweepStackHealth", () => {
  it("writes one observation per running stack and never transitions one", async () => {
    const substrate = new FakeSubstrate();
    const healthy = await seedRunningStack(substrate);
    const sick = await seedRunningStack(substrate);
    substrate.setUnhealthy(sick.refs);

    const result = await sweepStackHealth({ substrate, now: tick });
    expect(result.checked).toBeGreaterThanOrEqual(2);

    const [healthyRow] = await observations(healthy.stackId);
    expect(healthyRow).toMatchObject({
      healthy: true,
      detail: null,
      organizationId: ORG_ID,
    });

    const [sickRow] = await observations(sick.stackId);
    expect(sickRow).toMatchObject({
      healthy: false,
      detail: "stack was marked unhealthy",
    });

    // The EARS: no auto-transition. A sick stack is still `running`.
    const [row] = await db
      .select({ status: stacks.status })
      .from(stacks)
      .where(eq(stacks.id, sick.stackId));
    expect(row?.status).toBe("running");
  });

  it("records a throwing substrate as unhealthy rather than failing the sweep", async () => {
    const substrate = new FakeSubstrate();
    const first = await seedRunningStack(substrate);
    const second = await seedRunningStack(substrate);
    substrate.failNext("getHealth");

    const result = await sweepStackHealth({ substrate, now: tick });
    // `>=`, not `toBe(2)`, for the reason the sibling test above gives: the
    // sweep is UNSCOPED, and the `beforeEach` only clears THIS org. A dev
    // machine whose cloud database also holds a hand-made `running` stack
    // (they share port 5434) would otherwise fail here for no defect. What
    // this test actually certifies is asserted below, scoped to the two
    // stacks it seeded.
    expect(result.checked).toBeGreaterThanOrEqual(2);

    // The scripted failure hit ONE of the two; the other was still checked.
    const all = [
      ...(await observations(first.stackId)),
      ...(await observations(second.stackId)),
    ];
    expect(all).toHaveLength(2);
    expect(all.some((row) => row.detail?.includes("scripted failure"))).toBe(
      true,
    );
  });

  it("records a running stack with no substrate refs as unhealthy", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    await db
      .update(stacks)
      .set({ substrateRefs: {} })
      .where(eq(stacks.id, fixture.stackId));

    await sweepStackHealth({ substrate, now: tick });
    const [row] = await observations(fixture.stackId);
    expect(row).toMatchObject({
      healthy: false,
      detail: "stack has no substrate refs",
    });
  });
});

describe("getStackAlerts", () => {
  it("alerts after three consecutive unhealthy sweeps, not two", async () => {
    // THREE is written out rather than read from the constant on purpose: the
    // EARS names the number, so a test that looped `UNHEALTHY_ALERT_STREAK`
    // times would pass just as happily if the threshold were quietly changed.
    expect(UNHEALTHY_ALERT_STREAK).toBe(3);

    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    substrate.setUnhealthy(fixture.refs);

    await sweepStackHealth({ substrate, now: tick });
    await sweepStackHealth({ substrate, now: tick });
    // Two in a row is a blip, not an alert.
    let alerts = await getStackAlerts({ organizationId: ORG_ID });
    expect(alerts.map((alert) => alert.stackId)).not.toContain(fixture.stackId);

    await sweepStackHealth({ substrate, now: tick });
    alerts = await getStackAlerts({ organizationId: ORG_ID });
    const alert = alerts.find((row) => row.stackId === fixture.stackId);
    expect(alert).toBeDefined();
    expect(alert).toMatchObject({
      streak: 3,
      organizationId: ORG_ID,
      detail: "stack was marked unhealthy",
    });
  });

  it("clears the alert as soon as one healthy sweep lands", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    substrate.setUnhealthy(fixture.refs);
    for (let sweep = 0; sweep < UNHEALTHY_ALERT_STREAK; sweep += 1) {
      await sweepStackHealth({ substrate, now: tick });
    }
    expect(
      (await getStackAlerts({ organizationId: ORG_ID })).map((a) => a.stackId),
    ).toContain(fixture.stackId);

    // One good sweep is enough: the streak is the three MOST RECENT rows.
    substrate.setUnhealthy(fixture.refs, false);
    await sweepStackHealth({ substrate, now: tick });
    expect(
      (await getStackAlerts({ organizationId: ORG_ID })).map((a) => a.stackId),
    ).not.toContain(fixture.stackId);

    // And a single bad sweep after it does not re-raise it — the window still
    // holds the healthy row.
    substrate.setUnhealthy(fixture.refs);
    await sweepStackHealth({ substrate, now: tick });
    expect(
      (await getStackAlerts({ organizationId: ORG_ID })).map((a) => a.stackId),
    ).not.toContain(fixture.stackId);
  });

  it("does not alert on a stack that has left running", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    substrate.setUnhealthy(fixture.refs);
    for (let sweep = 0; sweep < UNHEALTHY_ALERT_STREAK; sweep += 1) {
      await sweepStackHealth({ substrate, now: tick });
    }
    expect(
      (await getStackAlerts({ organizationId: ORG_ID })).map((a) => a.stackId),
    ).toContain(fixture.stackId);

    await stackService.transition({
      stackId: fixture.stackId,
      to: "suspended",
    });
    expect(
      (await getStackAlerts({ organizationId: ORG_ID })).map((a) => a.stackId),
    ).not.toContain(fixture.stackId);
  });

  it("scopes alerts to one organization", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    substrate.setUnhealthy(fixture.refs);
    for (let sweep = 0; sweep < UNHEALTHY_ALERT_STREAK; sweep += 1) {
      await sweepStackHealth({ substrate, now: tick });
    }

    const other = await getStackAlerts({ organizationId: "some-other-org" });
    expect(other.map((alert) => alert.stackId)).not.toContain(fixture.stackId);
  });
});

describe("fake substrate health after suspend", () => {
  it("reports a suspended stack unhealthy, which is what the sweep records", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seedRunningStack(substrate);
    await substrate.suspend(fixture.refs);

    // The stack row is still `running` (nothing transitioned it), so the sweep
    // still visits it — and the substrate tells the truth about it.
    await sweepStackHealth({ substrate, now: tick });
    const rows = await observations(fixture.stackId);
    expect(rows.at(-1)).toMatchObject({
      healthy: false,
      detail: "stack is suspended",
    });
  });
});
