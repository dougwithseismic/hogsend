import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBilling } from "../billing/fake";
import { BillingError } from "../billing/types";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cloudAuditLog,
  emailAllowanceWarnings,
  emailOverageReports,
  environments,
  member,
  organization,
  organizations,
  usageCounters,
  user,
} from "../db/schema";
import { env } from "../env";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import {
  EMAIL_OVERAGE_METER,
  OVERAGE_DRIFT_ACTION,
  OVERAGE_RECONCILED_ACTION,
  reconcileEmailOverage,
  reportEmailOverage,
  warnEmailAllowance,
} from "../metering/overage";
import { recordRelayEmails } from "../services/email-usage";
import { planLimits } from "../services/plan-limits";
import { usageMonth } from "../services/usage";

/**
 * PRD 09 — overage reporting, reconciliation, and the warning that comes first.
 *
 * The rule every assertion here serves: **money that double-bills a customer is
 * the worst defect available in this PRD.** So the proofs are made against the
 * billing Fake's RECORD of what it was asked to bill, never against a return
 * value, and the double-report case asserts a length of one rather than "it
 * did not throw".
 *
 * Nothing here reaches Stripe. `FakeBilling` is injected into every call.
 */

const PAID_ORG = "email-overage-paid-org";
const TRIAL_ORG = "email-overage-trial-org";
const OWNER_ID = "email-overage-owner";
const OWNER_EMAIL = "owner@acme.test";

const NOW = new Date();
const PERIOD = usageMonth(NOW);
const ALLOWANCE = planLimits("self_serve").emailsPerMonth;

let billing: FakeBilling;
let sent: EmailMessage[];
let sender: EmailSender;
let seq = 0;

function deps() {
  return { db, billing, sender, now: () => NOW };
}

/** Park usage on a fresh environment of `organizationId`. */
async function useEmails(
  organizationId: string,
  count: number,
): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId, name: `overage-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  await recordRelayEmails(
    { organizationId, environmentId: row.id, count, at: NOW },
    db,
  );
  return row.id;
}

async function ledger(organizationId: string) {
  const [row] = await db
    .select()
    .from(emailOverageReports)
    .where(
      and(
        eq(emailOverageReports.organizationId, organizationId),
        eq(emailOverageReports.period, PERIOD),
      ),
    );
  return row;
}

async function auditActions(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.organizationId, organizationId));
  return rows.map((row) => row.action);
}

async function resetUsage(): Promise<void> {
  await db
    .delete(usageCounters)
    .where(inArray(usageCounters.organizationId, [PAID_ORG, TRIAL_ORG]));
  await db
    .delete(environments)
    .where(inArray(environments.organizationId, [PAID_ORG, TRIAL_ORG]));
  await db
    .delete(emailOverageReports)
    .where(inArray(emailOverageReports.organizationId, [PAID_ORG, TRIAL_ORG]));
  await db
    .delete(emailAllowanceWarnings)
    .where(
      inArray(emailAllowanceWarnings.organizationId, [PAID_ORG, TRIAL_ORG]),
    );
  await db
    .delete(cloudAuditLog)
    .where(inArray(cloudAuditLog.organizationId, [PAID_ORG, TRIAL_ORG]));
}

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [PAID_ORG, TRIAL_ORG]));
  await db
    .delete(organization)
    .where(inArray(organization.id, [PAID_ORG, TRIAL_ORG]));
  await db.delete(user).where(eq(user.id, OWNER_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values([
    {
      id: PAID_ORG,
      name: "Overage Paid Org",
      region: "us",
      plan: "self_serve",
    },
    { id: TRIAL_ORG, name: "Overage Trial Org", region: "us" },
  ]);
  // Better Auth's own tables: the owner the warning is addressed to.
  await db.insert(organization).values([
    { id: PAID_ORG, name: "Overage Paid Org" },
    { id: TRIAL_ORG, name: "Overage Trial Org" },
  ]);
  await db
    .insert(user)
    .values({ id: OWNER_ID, name: "Owner", email: OWNER_EMAIL });
  await db.insert(member).values({
    id: `${OWNER_ID}-member`,
    organizationId: PAID_ORG,
    userId: OWNER_ID,
    role: "owner",
  });
});

beforeEach(async () => {
  await resetUsage();
  billing = new FakeBilling();
  sent = [];
  sender = {
    id: "spy",
    async send(message) {
      sent.push(message);
    },
  };
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe("reportUsage on the billing contract", () => {
  it("records what it was asked to bill", async () => {
    const result = await billing.reportUsage({
      organizationId: PAID_ORG,
      meter: EMAIL_OVERAGE_METER,
      quantity: 42,
      period: PERIOD,
      idempotencyKey: "key-a",
      occurredAt: NOW,
    });

    expect(result).toEqual({ deduplicated: false });
    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]).toMatchObject({ quantity: 42 });
  });

  it("DEDUPLICATES a repeat of the same idempotency key", async () => {
    const input = {
      organizationId: PAID_ORG,
      meter: EMAIL_OVERAGE_METER,
      quantity: 42,
      period: PERIOD,
      idempotencyKey: "key-b",
      occurredAt: NOW,
    };
    await billing.reportUsage(input);
    const second = await billing.reportUsage(input);

    // The provider-side half of the guard. Without it, a lost response would
    // be indistinguishable from a failed call and the retry would bill twice.
    expect(second).toEqual({ deduplicated: true });
    expect(billing.usageReports).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe("reportEmailOverage (EARS 9)", () => {
  it("reports nothing for an organization inside its allowance", async () => {
    await useEmails(PAID_ORG, ALLOWANCE - 1);

    const result = await reportEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(0);
    expect(
      result.reports.find((row) => row.organizationId === PAID_ORG),
    ).toMatchObject({ overage: 0, reported: false });
  });

  it("reports the messages above the included allowance", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 250);

    await reportEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]).toMatchObject({
      organizationId: PAID_ORG,
      meter: EMAIL_OVERAGE_METER,
      quantity: 250,
      period: PERIOD,
    });
    expect(await ledger(PAID_ORG)).toMatchObject({
      reportedQuantity: 250,
      pendingQuantity: null,
    });
  });

  it("reports ONCE when the job runs twice", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 250);

    await reportEmailOverage(deps());
    await reportEmailOverage(deps());

    // The assertion that matters. A second invoice line for the same 250
    // messages is a customer complaint and a refund, not a rounding error.
    expect(billing.usageReports).toHaveLength(1);
    expect(await ledger(PAID_ORG)).toMatchObject({ reportedQuantity: 250 });
  });

  it("reports only the DELTA once usage grows", async () => {
    const environmentId = await useEmails(PAID_ORG, ALLOWANCE + 250);
    await reportEmailOverage(deps());

    await recordRelayEmails(
      { organizationId: PAID_ORG, environmentId, count: 100, at: NOW },
      db,
    );
    await reportEmailOverage(deps());

    expect(billing.usageReports.map((row) => row.quantity)).toEqual([250, 100]);
    expect(await ledger(PAID_ORG)).toMatchObject({ reportedQuantity: 350 });
  });

  it("never reports for a plan that does not bill overage", async () => {
    // A trial has no card on file. "Overage" would be an invoice nobody agreed
    // to, so the hard cap stops the sending instead.
    await useEmails(TRIAL_ORG, planLimits("trial").emailsPerMonth + 500);

    await reportEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(0);
  });

  it("does not double-bill when the ledger write is lost after the wire", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 250);
    await reportEmailOverage(deps());

    // The crash window: the provider took the usage, our commit never landed.
    // The claim is still sitting there, so the retry re-sends the SAME
    // identifier and the provider refuses to bill it twice.
    await db
      .update(emailOverageReports)
      .set({ reportedQuantity: 0, pendingQuantity: 250 })
      .where(eq(emailOverageReports.organizationId, PAID_ORG));

    await reportEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(1);
    expect(await ledger(PAID_ORG)).toMatchObject({
      reportedQuantity: 250,
      pendingQuantity: null,
    });
  });

  it("leaves the claim in place when the provider refuses, and retries it", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 250);
    billing.failNext("reportUsage", new BillingError("stripe is down"));

    const failed = await reportEmailOverage(deps());
    expect(failed.failed).toHaveLength(1);
    expect(await ledger(PAID_ORG)).toMatchObject({ pendingQuantity: 250 });

    await reportEmailOverage(deps());
    expect(billing.usageReports).toHaveLength(1);
    expect(await ledger(PAID_ORG)).toMatchObject({
      reportedQuantity: 250,
      pendingQuantity: null,
    });
  });

  it("bills each message once when a response is LOST and usage then grows", async () => {
    const environmentId = await useEmails(PAID_ORG, ALLOWANCE + 250);

    // The nastiest shape available: the provider took the usage and the caller
    // never found out. Anything that re-derives the key from the CURRENT usage
    // would now bill the first 250 twice.
    const lossy = {
      id: billing.id,
      createCheckout: billing.createCheckout.bind(billing),
      parseWebhook: billing.parseWebhook.bind(billing),
      getPortalUrl: billing.getPortalUrl.bind(billing),
      async reportUsage(input: Parameters<FakeBilling["reportUsage"]>[0]) {
        await billing.reportUsage(input);
        throw new BillingError("the response never came back");
      },
    };
    await reportEmailOverage({ ...deps(), billing: lossy });
    expect(billing.usageReports.map((row) => row.quantity)).toEqual([250]);

    await recordRelayEmails(
      { organizationId: PAID_ORG, environmentId, count: 150, at: NOW },
      db,
    );
    await reportEmailOverage(deps());
    await reportEmailOverage(deps());

    // 400 messages over the allowance, 400 messages billed. The retry replayed
    // the pinned key (deduplicated) and only the growth was new.
    expect(billing.usageReports.map((row) => row.quantity)).toEqual([250, 150]);
    expect(await ledger(PAID_ORG)).toMatchObject({ reportedQuantity: 400 });
  });

  it("clears a claim for a total that already settled, and bills later growth", async () => {
    const environmentId = await useEmails(PAID_ORG, ALLOWANCE + 250);
    await reportEmailOverage(deps());

    // An interrupted run whose report DID land, leaving its claim behind. If
    // the claim were left pinned, the key would never change again and no
    // later message would ever be billed.
    await db
      .update(emailOverageReports)
      .set({ pendingQuantity: 250 })
      .where(eq(emailOverageReports.organizationId, PAID_ORG));

    await reportEmailOverage(deps());
    expect(await ledger(PAID_ORG)).toMatchObject({
      reportedQuantity: 250,
      pendingQuantity: null,
    });

    await recordRelayEmails(
      { organizationId: PAID_ORG, environmentId, count: 40, at: NOW },
      db,
    );
    await reportEmailOverage(deps());

    expect(billing.usageReports.map((row) => row.quantity)).toEqual([250, 40]);
  });

  it("one failing organization does not stop the fleet", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 10);
    billing.failNext("reportUsage", new BillingError("stripe is down"));

    const result = await reportEmailOverage(deps());

    expect(result.failed).toHaveLength(1);
    // Every other org was still walked; the sweep returned rather than threw.
    expect(result.period).toBe(PERIOD);
  });

  it("closes the PREVIOUS month within 48h of the boundary", async () => {
    // The revenue-leak shape: a send on the LAST day of month M, billed by the
    // nightly run early in M+1. If billing only ever looked at periodOf(now) it
    // would bill M+1 (empty) and the tail of M — counted but past M's last run —
    // would be metered and never invoiced. `sweepPeriods` closes M too.
    const lastDayOfM = new Date(Date.UTC(2026, 0, 31, 23, 0, 0)); // 2026-01-31
    const earlyMPlus1 = new Date(Date.UTC(2026, 1, 1, 3, 0, 0)); // 2026-02-01 03:00
    const prevPeriod = usageMonth(lastDayOfM); // 2026-01

    seq += 1;
    const [row] = await db
      .insert(environments)
      .values({
        organizationId: PAID_ORG,
        name: `overage-${seq}`,
        kind: "test",
      })
      .returning();
    if (!row) throw new Error("failed to seed environment");
    await recordRelayEmails(
      {
        organizationId: PAID_ORG,
        environmentId: row.id,
        count: ALLOWANCE + 300,
        at: lastDayOfM,
      },
      db,
    );

    await reportEmailOverage({
      db,
      billing,
      sender,
      now: () => earlyMPlus1,
    });

    // Billed for month M, from a run in M+1.
    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]).toMatchObject({
      organizationId: PAID_ORG,
      quantity: 300,
      period: prevPeriod,
    });
    // ...and the ledger row lands under M, so a re-run is a no-op.
    const [led] = await db
      .select()
      .from(emailOverageReports)
      .where(
        and(
          eq(emailOverageReports.organizationId, PAID_ORG),
          eq(emailOverageReports.period, prevPeriod),
        ),
      );
    expect(led).toMatchObject({ reportedQuantity: 300, pendingQuantity: null });
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe("reconcileEmailOverage (EARS 10)", () => {
  it("repairs a usage record that was counted but never billed", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 500);
    await reportEmailOverage(deps());
    billing.reset();

    // Injected drift: the ledger claims nothing was reported.
    await db
      .update(emailOverageReports)
      .set({ reportedQuantity: 0, pendingQuantity: null })
      .where(eq(emailOverageReports.organizationId, PAID_ORG));

    const result = await reconcileEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(1);
    expect(billing.usageReports[0]).toMatchObject({ quantity: 500 });
    expect(result.repaired).toMatchObject([
      { organizationId: PAID_ORG, delta: 500 },
    ]);
    // "and record that it did".
    expect(await auditActions(PAID_ORG)).toContain(OVERAGE_RECONCILED_ACTION);
  });

  it("records drift the other way without trying to un-bill it", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 100);
    await reportEmailOverage(deps());
    billing.reset();

    await db
      .update(emailOverageReports)
      .set({ reportedQuantity: 900 })
      .where(eq(emailOverageReports.organizationId, PAID_ORG));

    const result = await reconcileEmailOverage(deps());

    // A meter event cannot be withdrawn, so the honest move is to say so
    // rather than to send a negative quantity nobody would accept.
    expect(billing.usageReports).toHaveLength(0);
    expect(result.drifted).toMatchObject([
      { organizationId: PAID_ORG, reported: 900, counted: 100 },
    ]);
    expect(await auditActions(PAID_ORG)).toContain(OVERAGE_DRIFT_ACTION);
  });

  it("is quiet when nothing has drifted", async () => {
    await useEmails(PAID_ORG, ALLOWANCE + 100);
    await reportEmailOverage(deps());
    billing.reset();

    const result = await reconcileEmailOverage(deps());

    expect(billing.usageReports).toHaveLength(0);
    expect(result.repaired).toHaveLength(0);
    expect(result.drifted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe("warnEmailAllowance (EARS 8)", () => {
  it("says nothing below the first threshold", async () => {
    await useEmails(PAID_ORG, Math.floor(ALLOWANCE * 0.5));

    const result = await warnEmailAllowance(deps());

    expect(sent).toHaveLength(0);
    expect(result.notices).toHaveLength(0);
  });

  it("tells the owner once when usage crosses 80%", async () => {
    await useEmails(PAID_ORG, Math.floor(ALLOWANCE * 0.8));

    const result = await warnEmailAllowance(deps());

    expect(result.notices).toMatchObject([
      { organizationId: PAID_ORG, percent: 80 },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OWNER_EMAIL);
    expect(sent[0]?.subject).toContain("80%");
  });

  it("does not repeat a threshold it has already sent this period", async () => {
    await useEmails(PAID_ORG, Math.floor(ALLOWANCE * 0.8));

    await warnEmailAllowance(deps());
    const second = await warnEmailAllowance(deps());

    expect(second.notices).toHaveLength(0);
    expect(second.suppressed).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  it("sends the next threshold when usage reaches the allowance", async () => {
    const environmentId = await useEmails(
      PAID_ORG,
      Math.floor(ALLOWANCE * 0.8),
    );
    await warnEmailAllowance(deps());

    await recordRelayEmails(
      {
        organizationId: PAID_ORG,
        environmentId,
        count: Math.ceil(ALLOWANCE * 0.2),
        at: NOW,
      },
      db,
    );
    const result = await warnEmailAllowance(deps());

    expect(result.notices).toMatchObject([
      { organizationId: PAID_ORG, percent: 100 },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toContain("100%");
  });

  it("records one row per threshold per period", async () => {
    await useEmails(PAID_ORG, ALLOWANCE);

    await warnEmailAllowance(deps());
    await warnEmailAllowance(deps());

    const rows = await db
      .select()
      .from(emailAllowanceWarnings)
      .where(eq(emailAllowanceWarnings.organizationId, PAID_ORG));
    expect(rows.map((row) => row.percent).sort((a, b) => a - b)).toEqual([
      80, 100,
    ]);
  });
});
