import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations, stacks } from "../db/schema";
import { env } from "../env";
import {
  DEFAULT_PROVISION_ATTEMPT_CEILING,
  sweepProvisions,
} from "../pipeline/provision-sweep";
import type { StackStatus } from "../services/stacks";

/**
 * The provision sweep, against the real control-plane database.
 *
 * Every assertion is about WHICH rows the sweep chose, so the pipeline itself
 * is injected as a spy (`run`) — this test is about the selection rule and the
 * pacing, not about provisioning, which `provision.test.ts` owns.
 *
 * The clock and the sleep are both INJECTED. A pacing test that actually slept
 * would trade two real seconds for no extra confidence, and a stale-window test
 * that relied on wall time would be a race.
 */

const ORG_ID = "provision-sweep-test-org";

/**
 * The sweep is deliberately UNSCOPED — it visits every matching stack in the
 * database, which is the whole point of a control-plane cron. So each test
 * starts from an empty stack table, and the delete is GLOBAL rather than scoped
 * to `ORG_ID`: a stack belonging to any other org (a row left behind by local
 * development, say) is picked up by the sweep like any other, and would show up
 * in `redriven`/`needsCredentials` as a phantom this test never seeded.
 * Environments cascade to stacks, so one delete clears both.
 */
beforeEach(async () => {
  await db.delete(environments);
});

interface SeedOptions {
  status: StackStatus;
  lastError?: string;
  retryCount?: number;
  updatedAt?: Date;
  substrateRefs?: Record<string, unknown>;
}

async function seedStack(options: SeedOptions): Promise<string> {
  const suffix = randomBytes(4).toString("hex");
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG_ID,
      name: `provision-sweep-${suffix}`,
      kind: "test",
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const [row] = await db
    .insert(stacks)
    .values({
      organizationId: ORG_ID,
      environmentId: environment.id,
      region: "us",
      status: options.status,
      lastError: options.lastError ?? null,
      retryCount: options.retryCount ?? 0,
      substrateRefs: options.substrateRefs ?? {},
      // Written explicitly: the stale rule reads `updated_at`, and a fixture
      // that let the default stand would only ever test the "fresh" branch.
      updatedAt: options.updatedAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error("fixture stack not created");
  return row.id;
}

/** A recorder standing in for the pipeline, plus a fake pacing clock. */
function spy() {
  const dispatched: string[] = [];
  const slept: number[] = [];
  return {
    dispatched,
    slept,
    run: async (stackId: string) => {
      dispatched.push(stackId);
    },
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await db
    .insert(organizations)
    .values({ id: ORG_ID, name: "Provision Sweep Test", region: "us" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(environments).where(eq(environments.organizationId, ORG_ID));
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
  await sqlClient.end({ timeout: 5 });
});

describe("sweepProvisions", () => {
  it("re-drives a stack parked at a provision step", async () => {
    const stackId = await seedStack({
      status: "error",
      // The exact shape `runProvisionPipeline` records: `[step] message`.
      lastError: "[set-env] Problem processing request",
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(probe.dispatched).toEqual([stackId]);
    expect(result.redriven).toEqual([stackId]);
    expect(result.exhausted).toEqual([]);
  });

  it("leaves an error parked by something OTHER than provisioning alone", async () => {
    // The build sweep parks stacks in `error` too. Re-provisioning one would
    // skip every substrate step on its persisted artifacts and then declare it
    // `running` on the old image, hiding a publish failure.
    const stackId = await seedStack({
      status: "error",
      lastError:
        "[build 1234] the builder was interrupted while deploying; the rollout was never confirmed",
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(probe.dispatched).not.toContain(stackId);
    expect(result.redriven).not.toContain(stackId);
  });

  it("re-drives a stack abandoned mid-provision", async () => {
    const stackId = await seedStack({
      status: "provisioning",
      updatedAt: HOUR_AGO(),
    });
    const probe = spy();

    const result = await sweepProvisions({
      db,
      run: probe.run,
      limit: 5,
      staleAfterMs: 15 * 60 * 1000,
    });

    expect(result.redriven).toEqual([stackId]);
    // Parked on the way past, which is the ONLY thing that makes the ceiling
    // bind: a worker killed mid-run never reaches `recordError` itself.
    const [row] = await db
      .select({ retryCount: stacks.retryCount, lastError: stacks.lastError })
      .from(stacks)
      .where(eq(stacks.id, stackId));
    expect(row?.retryCount).toBe(1);
    expect(row?.lastError).toMatch(/interrupted while provisioning/i);
  });

  it("eventually exhausts a stack that is abandoned mid-provision every time", async () => {
    // The failure class this sweep exists for: a worker that dies at the same
    // step every tick. Without the park it would be re-driven forever, never
    // cross the ceiling, and never raise the T3 alert.
    const stackId = await seedStack({
      status: "provisioning",
      updatedAt: HOUR_AGO(),
    });

    const seen: string[][] = [];
    for (let tick = 0; tick <= DEFAULT_PROVISION_ATTEMPT_CEILING; tick += 1) {
      const result = await sweepProvisions({
        db,
        run: spy().run,
        limit: 5,
        staleAfterMs: 15 * 60 * 1000,
      });
      seen.push(result.redriven);
      if (result.exhausted.includes(stackId)) {
        expect(result.redriven).toEqual([]);
        expect(seen).toHaveLength(DEFAULT_PROVISION_ATTEMPT_CEILING + 1);
        return;
      }
      // The worker dies again: back to `provisioning`, silent since.
      await db
        .update(stacks)
        .set({ status: "provisioning", updatedAt: HOUR_AGO() })
        .where(eq(stacks.id, stackId));
    }
    throw new Error("stack was re-driven forever and never exhausted");
  });

  it("leaves a provision that is merely slow alone", async () => {
    // A stack inside the pipeline's ten-minute health wait is not stuck, and
    // re-driving it would race a live run against itself.
    const stackId = await seedStack({
      status: "provisioning",
      updatedAt: new Date(Date.now() - 60_000),
    });
    const probe = spy();

    const result = await sweepProvisions({
      db,
      run: probe.run,
      limit: 5,
      staleAfterMs: 15 * 60 * 1000,
    });

    expect(probe.dispatched).toEqual([]);
    expect(result.redriven).not.toContain(stackId);
  });

  it("reports a running stack with no minted credentials, and dispatches nothing", async () => {
    const stackId = await seedStack({
      status: "running",
      substrateRefs: {
        substrate: "fake",
        apiPublicUrl: "https://example.invalid",
        credentialsMinted: false,
      },
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(result.needsCredentials).toEqual([stackId]);
    // Two independent reasons it must not be dispatched: there is no
    // `running → provisioning` edge, and `mint-credentials` is still a no-op
    // until PRD 13 T2.
    expect(probe.dispatched).toEqual([]);
    expect(result.redriven).toEqual([]);
  });

  it("reports a running stack that predates the credentials key at all", async () => {
    // No `credentialsMinted` key: `->> 'credentialsMinted'` is NULL, which a
    // plain `!= 'true'` would silently drop.
    const stackId = await seedStack({
      status: "running",
      substrateRefs: { substrate: "fake" },
    });

    const result = await sweepProvisions({ db, run: spy().run });

    expect(result.needsCredentials).toEqual([stackId]);
  });

  it("ignores a running stack whose credentials were minted", async () => {
    await seedStack({
      status: "running",
      substrateRefs: { substrate: "fake", credentialsMinted: true },
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(result.needsCredentials).toEqual([]);
    expect(result.redriven).toEqual([]);
    expect(probe.dispatched).toEqual([]);
  });

  it("never touches a stack a human suspended", async () => {
    const stackId = await seedStack({
      status: "suspended",
      updatedAt: HOUR_AGO(),
      lastError: "[set-env] Problem processing request",
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(probe.dispatched).toEqual([]);
    expect(result.redriven).toEqual([]);
    expect(result.needsCredentials).toEqual([]);
    // And the row is exactly as it was.
    const [row] = await db
      .select({ status: stacks.status })
      .from(stacks)
      .where(eq(stacks.id, stackId));
    expect(row?.status).toBe("suspended");
  });

  it("stops re-driving a stack past the attempt ceiling", async () => {
    const stackId = await seedStack({
      status: "error",
      lastError: "[mint-hatchet] Not Authorized",
      retryCount: DEFAULT_PROVISION_ATTEMPT_CEILING,
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(probe.dispatched).toEqual([]);
    expect(result.redriven).toEqual([]);
    // Named rather than silently skipped: an exhausted stack is what T3 alerts
    // on, and a sweep that dropped it would be the same outage, quieter.
    expect(result.exhausted).toEqual([stackId]);
  });

  it("still re-drives a stack one attempt short of the ceiling", async () => {
    const stackId = await seedStack({
      status: "error",
      lastError: "[mint-hatchet] Problem processing request",
      retryCount: DEFAULT_PROVISION_ATTEMPT_CEILING - 1,
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 5 });

    expect(result.redriven).toEqual([stackId]);
    expect(result.exhausted).toEqual([]);
  });

  it("paces between re-drives, and never before the first", async () => {
    await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      updatedAt: HOUR_AGO(),
    });
    const probe = spy();

    const result = await sweepProvisions({
      db,
      run: probe.run,
      sleep: probe.sleep,
      limit: 2,
      pacingMs: 2000,
    });

    expect(result.redriven).toHaveLength(2);
    // One gap for two re-drives: the pause spreads substrate calls, and a tick
    // that slept before doing any work would only delay the recovery.
    expect(probe.slept).toEqual([2000]);
  });

  it("does not count a dispatch that threw as a re-drive", async () => {
    await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
    });

    // `runProvisionPipeline` returns rather than throws, so this is the
    // unexpected case — swallowed, but never reported as work done.
    const result = await sweepProvisions({
      db,
      run: async () => {
        throw new Error("substrate could not be constructed");
      },
      limit: 5,
    });

    expect(result.redriven).toEqual([]);
  });

  it("takes at most `limit` stacks per tick, oldest first", async () => {
    const oldest = await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    await seedStack({
      status: "error",
      lastError: "[set-env] Problem processing request",
      updatedAt: HOUR_AGO(),
    });
    const probe = spy();

    const result = await sweepProvisions({ db, run: probe.run, limit: 1 });

    expect(result.redriven).toEqual([oldest]);
    expect(probe.slept).toEqual([]);
  });
});
