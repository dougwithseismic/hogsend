import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BillingEvent,
  type BillingEventType,
  type BillingPlan,
  stripeEventToBillingEvent,
} from "../billing";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, cloudAuditLog, organizations } from "../db/schema";
import { env } from "../env";
import { DUNNING_GRACE_DAYS, PlanService } from "../services/billing-plan";
import { OrgService } from "../services/orgs";
import { PLAN_LIMITS, planLimits } from "../services/plan-limits";

/**
 * Against the REAL database: every rule here is a write — a plan column, a
 * nullable `dunning_since`, a suspension, an append-only audit row — and the
 * idempotency claim ("a second payment_failed does not restart the clock") is
 * only meaningful against real row state.
 */

const CELL = "billing-plan-us-1";
const ORG_IDS = [
  "billing-plan-upgrade",
  "billing-plan-dedicated",
  "billing-plan-dunning",
  "billing-plan-cancel",
  "billing-plan-grace",
  "billing-plan-recover",
  "billing-plan-pastdue",
  "billing-plan-resubscribe",
  "billing-plan-abuse",
];

const orgs = new OrgService(db);
const plans = new PlanService(db);

const DAY_MS = 86_400_000;

function event(
  type: BillingEventType,
  organizationId: string,
  overrides: Partial<BillingEvent> = {},
): BillingEvent {
  return {
    type,
    organizationId,
    plan: null,
    eventId: `evt_${type}_${organizationId}`,
    occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    raw: {},
    ...overrides,
  };
}

async function seedOrg(id: string, plan: BillingPlan | "trial" = "trial") {
  await orgs.create({ id, name: id, region: "us", plan });
}

async function readOrg(id: string) {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  if (!row) throw new Error(`missing org ${id}`);
  return row;
}

/**
 * SORTED, deliberately. Audit rows written inside one transaction share
 * `now()`, so a `created_at` ordering cannot separate them and an
 * order-sensitive assertion here would be a coin flip rather than a rule. What
 * IS a rule is the multiset of actions a transition writes.
 */
async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, organizationId));
  return rows.map((r) => r.action).sort();
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

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("planLimits", () => {
  it("matches DECISIONS §2 verbatim", () => {
    expect(planLimits("trial")).toEqual({
      environments: 1,
      eventsPerMonth: 10_000,
      emailsPerMonth: 1_000,
      // No card on file, so the allowance IS the cap (PRD 09).
      emailOverage: false,
      emailHardCap: 1_000,
    });
    expect(planLimits("self_serve")).toEqual({
      environments: 2,
      eventsPerMonth: 100_000,
      emailsPerMonth: 10_000,
      emailOverage: true,
      emailHardCap: 100_000,
    });
    expect(planLimits("dedicated")).toEqual({
      environments: 4,
      eventsPerMonth: 1_000_000,
      emailsPerMonth: 100_000,
      emailOverage: true,
      emailHardCap: 1_000_000,
    });
  });

  it("caps every plan at or above its included allowance", () => {
    // A cap BELOW the allowance would sell a number the gate refuses to honour.
    for (const plan of ["trial", "self_serve", "dedicated"] as const) {
      const limits = planLimits(plan);
      expect(limits.emailHardCap).toBeGreaterThanOrEqual(limits.emailsPerMonth);
      // And a plan that does not bill overage must not leave headroom above the
      // allowance that nobody would ever be invoiced for.
      if (!limits.emailOverage) {
        expect(limits.emailHardCap).toBe(limits.emailsPerMonth);
      }
    }
  });

  it("covers every plan the database can hold", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([
      "dedicated",
      "self_serve",
      "trial",
    ]);
  });
});

describe("PlanService.applyBillingEvent — plan changes", () => {
  it("moves a trial to self_serve on checkout, clearing the trial clock", async () => {
    await seedOrg("billing-plan-upgrade");
    expect((await readOrg("billing-plan-upgrade")).trialEndsAt).toBeInstanceOf(
      Date,
    );

    const result = await plans.applyBillingEvent(
      event("checkout_completed", "billing-plan-upgrade", {
        plan: "self_serve",
        customerRef: "cus_upgrade",
      }),
      { actor: "stripe" },
    );

    expect(result.planChanged).toBe(true);
    const org = await readOrg("billing-plan-upgrade");
    expect(org.plan).toBe("self_serve");
    // The 14-day clock belonged to the trial; a paying org must not keep it.
    expect(org.trialEndsAt).toBeNull();
    expect(org.billingCustomerId).toBe("cus_upgrade");
    expect(await auditActions("billing-plan-upgrade")).toEqual([
      "billing.plan_changed",
      "org.created",
    ]);
  });

  it("is idempotent: re-delivering the same event changes nothing", async () => {
    const before = await readOrg("billing-plan-upgrade");
    const result = await plans.applyBillingEvent(
      event("subscription_updated", "billing-plan-upgrade", {
        plan: "self_serve",
      }),
    );

    expect(result.planChanged).toBe(false);
    expect((await readOrg("billing-plan-upgrade")).updatedAt).toEqual(
      before.updatedAt,
    );
    expect(await auditActions("billing-plan-upgrade")).toEqual([
      "billing.plan_changed",
      "org.created",
    ]);
  });

  it("upgrading to dedicated parks a re-provision note and touches no stack", async () => {
    await seedOrg("billing-plan-dedicated");

    const result = await plans.applyBillingEvent(
      event("subscription_updated", "billing-plan-dedicated", {
        plan: "dedicated",
      }),
    );

    expect(result.planChanged).toBe(true);
    expect((await readOrg("billing-plan-dedicated")).plan).toBe("dedicated");
    // The topology move itself is PRD 11's; this wave records the debt.
    expect(await auditActions("billing-plan-dedicated")).toEqual([
      "billing.plan_changed",
      "billing.reprovision_deferred",
      "org.created",
    ]);
    // The org stays on its shared cell until PRD 11 actually re-provisions it.
    expect((await readOrg("billing-plan-dedicated")).cellId).not.toBeNull();
  });

  it("ignores an event for an organization the control plane does not have", async () => {
    const result = await plans.applyBillingEvent(
      event("checkout_completed", "billing-plan-ghost", { plan: "self_serve" }),
    );
    expect(result.applied).toBe(false);
    expect(result.planChanged).toBe(false);
  });
});

describe("PlanService.applyBillingEvent — dunning", () => {
  it("starts the grace clock on the first payment_failed, once", async () => {
    await seedOrg("billing-plan-dunning", "self_serve");

    await plans.applyBillingEvent(
      event("payment_failed", "billing-plan-dunning"),
    );
    const first = await readOrg("billing-plan-dunning");
    expect(first.dunningSince).toBeInstanceOf(Date);
    expect(first.suspendedAt).toBeNull();

    await plans.applyBillingEvent(
      event("payment_failed", "billing-plan-dunning", { eventId: "evt_again" }),
    );
    const second = await readOrg("billing-plan-dunning");
    // The clock is the FIRST failure's — a retry must not extend the grace.
    expect(second.dunningSince?.getTime()).toBe(first.dunningSince?.getTime());

    // Both failures are recorded; only the first started the clock.
    const actions = await auditActions("billing-plan-dunning");
    expect(actions).toEqual([
      "billing.dunning_started",
      "billing.payment_failed",
      "billing.payment_failed",
      "org.created",
    ]);
  });

  it("clears the clock on a successful subscription update", async () => {
    await plans.applyBillingEvent(
      event("subscription_updated", "billing-plan-dunning", {
        plan: "self_serve",
      }),
    );

    const org = await readOrg("billing-plan-dunning");
    expect(org.dunningSince).toBeNull();
    expect(await auditActions("billing-plan-dunning")).toContain(
      "billing.dunning_cleared",
    );
  });

  it("suspends an org whose grace has run out, and only then", async () => {
    await seedOrg("billing-plan-grace", "self_serve");
    await plans.applyBillingEvent(
      event("payment_failed", "billing-plan-grace"),
    );

    const started = (await readOrg("billing-plan-grace")).dunningSince;
    if (!started) throw new Error("expected a dunning clock");

    // One second inside the grace: nothing happens.
    const inside = await plans.enforceDunningGrace({
      now: new Date(started.getTime() + DUNNING_GRACE_DAYS * DAY_MS - 1000),
    });
    expect(inside.suspended).not.toContain("billing-plan-grace");
    expect((await readOrg("billing-plan-grace")).suspendedAt).toBeNull();

    // One second past it: suspended.
    const outside = await plans.enforceDunningGrace({
      now: new Date(started.getTime() + DUNNING_GRACE_DAYS * DAY_MS + 1000),
      actor: "billing-sweep",
    });
    expect(outside.suspended).toContain("billing-plan-grace");
    expect((await readOrg("billing-plan-grace")).suspendedAt).toBeInstanceOf(
      Date,
    );
    expect(await auditActions("billing-plan-grace")).toContain(
      "billing.dunning_expired",
    );

    // Idempotent: a second sweep does not re-suspend an already-suspended org.
    const again = await plans.enforceDunningGrace({
      now: new Date(started.getTime() + DUNNING_GRACE_DAYS * DAY_MS + 2000),
    });
    expect(again.suspended).not.toContain("billing-plan-grace");
  });

  /**
   * The whole grace period hangs on this. Stripe flips a subscription to
   * `past_due` on the SAME charge failure that emits `invoice.payment_failed`,
   * and emits `customer.subscription.updated` for the status change. If that
   * update reached `applyGoodStanding` it would clear `dunning_since` on every
   * failed charge — the sweep would never find an expired row and nobody would
   * ever be suspended for non-payment. So this drives the REAL Stripe payload
   * through the real mapper rather than hand-building a `BillingEvent`.
   */
  it("a Stripe past_due subscription update never clears a running clock", async () => {
    await seedOrg("billing-plan-pastdue", "self_serve");
    await plans.applyBillingEvent(
      event("payment_failed", "billing-plan-pastdue"),
    );
    const started = (await readOrg("billing-plan-pastdue")).dunningSince;
    if (!started) throw new Error("expected a dunning clock");

    const mapped = stripeEventToBillingEvent(
      {
        id: "evt_past_due",
        type: "customer.subscription.updated",
        created: 1_800_000_000,
        data: {
          object: {
            status: "past_due",
            customer: "cus_pastdue",
            metadata: {
              organizationId: "billing-plan-pastdue",
              plan: "self_serve",
            },
          },
        },
      },
      new Map(),
    );

    // Verified, and deliberately not actionable: the invoice events are the
    // single writer of the dunning clock.
    expect(mapped).toBeNull();
    if (mapped) await plans.applyBillingEvent(mapped);

    const org = await readOrg("billing-plan-pastdue");
    expect(org.dunningSince?.getTime()).toBe(started.getTime());
    expect(await auditActions("billing-plan-pastdue")).not.toContain(
      "billing.dunning_cleared",
    );
  });

  it("brings a dunning-suspended org back when payment recovers", async () => {
    await seedOrg("billing-plan-recover", "self_serve");
    await plans.applyBillingEvent(
      event("payment_failed", "billing-plan-recover"),
    );
    const started = (await readOrg("billing-plan-recover")).dunningSince;
    if (!started) throw new Error("expected a dunning clock");
    await plans.enforceDunningGrace({
      now: new Date(started.getTime() + (DUNNING_GRACE_DAYS + 1) * DAY_MS),
    });
    expect((await readOrg("billing-plan-recover")).suspendedAt).toBeInstanceOf(
      Date,
    );

    await plans.applyBillingEvent(
      event("subscription_updated", "billing-plan-recover", {
        plan: "self_serve",
      }),
    );

    const org = await readOrg("billing-plan-recover");
    expect(org.dunningSince).toBeNull();
    expect(org.suspendedAt).toBeNull();
    expect(await auditActions("billing-plan-recover")).toContain(
      "org.unsuspended",
    );
  });
});

describe("PlanService.applyBillingEvent — cancellation", () => {
  it("suspends immediately and records the cancellation", async () => {
    await seedOrg("billing-plan-cancel", "self_serve");

    const result = await plans.applyBillingEvent(
      event("subscription_canceled", "billing-plan-cancel"),
      { actor: "stripe" },
    );

    expect(result.applied).toBe(true);
    const org = await readOrg("billing-plan-cancel");
    expect(org.suspendedAt).toBeInstanceOf(Date);
    // Data is kept and the plan is left standing: suspension stops the stack,
    // it does not rewrite what the tenant bought.
    expect(org.plan).toBe("self_serve");
    expect(org.dunningSince).toBeNull();
    expect(await auditActions("billing-plan-cancel")).toEqual([
      "billing.subscription_canceled",
      "org.created",
      "org.suspended",
    ]);
  });

  it("brings a cancelled tenant back when they re-subscribe", async () => {
    await seedOrg("billing-plan-resubscribe", "self_serve");
    await plans.applyBillingEvent(
      event("subscription_canceled", "billing-plan-resubscribe"),
    );
    const stopped = await readOrg("billing-plan-resubscribe");
    expect(stopped.suspendedAt).toBeInstanceOf(Date);
    expect(stopped.suspendedReason).toBe("billing");

    await plans.applyBillingEvent(
      event("checkout_completed", "billing-plan-resubscribe", {
        plan: "self_serve",
        customerRef: "cus_resubscribe",
      }),
    );

    // The customer paid; the stack comes back. A suspension that survived the
    // new subscription would be billing a tenant for something switched off.
    const org = await readOrg("billing-plan-resubscribe");
    expect(org.suspendedAt).toBeNull();
    expect(org.suspendedReason).toBeNull();
    expect(await auditActions("billing-plan-resubscribe")).toContain(
      "org.unsuspended",
    );
  });

  it("never lifts an ops suspension, however much the tenant pays", async () => {
    await seedOrg("billing-plan-abuse", "self_serve");
    await orgs.suspend({
      id: "billing-plan-abuse",
      actor: "ops",
      reason: "abuse",
    });

    await plans.applyBillingEvent(
      event("checkout_completed", "billing-plan-abuse", {
        plan: "dedicated",
        customerRef: "cus_abuse",
      }),
    );

    const org = await readOrg("billing-plan-abuse");
    // The plan is theirs to buy; the suspension is not theirs to lift.
    expect(org.plan).toBe("dedicated");
    expect(org.suspendedAt).toBeInstanceOf(Date);
    expect(org.suspendedReason).toBe("abuse");
    expect(await auditActions("billing-plan-abuse")).not.toContain(
      "org.unsuspended",
    );
  });

  it("is idempotent: a re-delivered cancellation does not re-suspend", async () => {
    const before = await readOrg("billing-plan-cancel");
    await plans.applyBillingEvent(
      event("subscription_canceled", "billing-plan-cancel"),
    );
    const after = await readOrg("billing-plan-cancel");
    expect(after.suspendedAt?.getTime()).toBe(before.suspendedAt?.getTime());
    expect(
      (await auditActions("billing-plan-cancel")).filter(
        (a) => a === "org.suspended",
      ),
    ).toHaveLength(1);
  });
});
