import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { environments, organizations, usageCounters } from "../db/schema";
import { env } from "../env";
import { decideAllowance } from "../lib/email-allowance";
import { handleRelaySend, handleRelaySendBatch } from "../lib/email-relay";
import {
  createEmailAllowanceGate,
  readRelayEmailsForPeriod,
  recordRelayEmails,
} from "../services/email-usage";
import { planLimits } from "../services/plan-limits";
import { RelayTokenService } from "../services/relay-tokens";
import { usageMonth } from "../services/usage";
import { FakeSesClient } from "../ses/fake";
import { resetSesClients } from "../ses/index";
import { sesTenantName } from "../ses/names";

/**
 * PRD 09 — the allowance gate and the meter behind it.
 *
 * Two rules decide every assertion in this file:
 *
 *  - **the COUNTER is the evidence, never the response.** A double-count bug
 *    produces two identical-looking 200s; only the counter row can tell you
 *    whether the second one cost the customer a message. Every metering
 *    assertion here reads `usage_counters`;
 *  - **nothing reaches AWS or Stripe.** The relay takes its `SesClient` as a
 *    dependency and every case passes a `FakeSesClient`.
 */

const TRIAL_ORG = "email-allowance-trial-org";
const PAID_ORG = "email-allowance-paid-org";

/** Pinned once, so every counter write in a run lands in one `YYYY-MM` and the
 * assertions never straddle a month boundary. */
const NOW = new Date();
const MONTH = usageMonth(NOW);

const tokens = new RelayTokenService(db);

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;
/** The one address the Fake refuses, so a partial failure is reproducible. */
const BAD_RECIPIENT = "bounce@acme.test";

let seq = 0;

interface Fixture {
  environmentId: string;
  organizationId: string;
  token: string;
  ses: FakeSesClient;
}

/** Put the Fake into the state a fully provisioned environment is in. */
async function makeSendReady(
  ses: FakeSesClient,
  tenantName: string,
): Promise<void> {
  await ses.createTenant({ tenantName });
  if (!ses.calls.some((call) => call.method === "createIdentity")) {
    await ses.createIdentity({ domain: DOMAIN });
    ses.__verifyIdentity(DOMAIN);
  }
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
}

async function seed(organizationId = TRIAL_ORG): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId, name: `allowance-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  const { token } = await tokens.mint({ environmentId: row.id });
  const ses = new FakeSesClient({ region: "us" });
  await makeSendReady(ses, sesTenantName(row.id));
  return { environmentId: row.id, organizationId, token, ses };
}

function message(to = "person@example.test") {
  return {
    from: "Acme <hello@acme.test>",
    to: [to],
    subject: "Your weekly digest",
    html: "<p>Hello</p>",
  };
}

function sendRequest(options: {
  token: string;
  idempotencyKey: string;
  to?: string;
}): Request {
  return new Request("http://localhost:3004/api/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
      "idempotency-key": options.idempotencyKey,
    },
    body: JSON.stringify({ message: message(options.to) }),
  });
}

function batchRequest(
  token: string,
  items: { idempotencyKey: string; to: string }[],
): Request {
  return new Request("http://localhost:3004/api/email/send-batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      items: items.map((item) => ({
        idempotencyKey: item.idempotencyKey,
        message: message(item.to),
      })),
    }),
  });
}

/** How many times the wire was actually touched. */
function sendCalls(ses: FakeSesClient): number {
  return ses.calls.filter(
    (call) => call.method === "sendEmail" || call.method === "sendBatch",
  ).length;
}

/** The metered number, straight out of the sink. Zero when no row exists. */
async function metered(environmentId: string): Promise<number> {
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.environmentId, environmentId),
        eq(usageCounters.month, MONTH),
      ),
    );
  return row?.relayEmailsCount ?? 0;
}

/** Park a used-up allowance on an environment without sending anything. */
async function preloadUsage(fixture: Fixture, count: number): Promise<void> {
  await recordRelayEmails(
    {
      organizationId: fixture.organizationId,
      environmentId: fixture.environmentId,
      count,
      at: NOW,
    },
    db,
  );
}

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [TRIAL_ORG, PAID_ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values([
    { id: TRIAL_ORG, name: "Allowance Trial Org", region: "us" },
    {
      id: PAID_ORG,
      name: "Allowance Paid Org",
      region: "us",
      plan: "self_serve",
    },
  ]);
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

// ---------------------------------------------------------------------------
// The decision, as a pure function
// ---------------------------------------------------------------------------

describe("decideAllowance — the rule, with no database in the way", () => {
  const plan = {
    limit: 1_000,
    overageEnabled: false,
    hardCap: 1_000,
  };

  it("allows while the period's count is below the allowance", () => {
    expect(decideAllowance({ ...plan, used: 10, count: 1 })).toEqual({
      allowed: true,
    });
  });

  it("allows the request that exactly fills the allowance", () => {
    expect(decideAllowance({ ...plan, used: 999, count: 1 })).toEqual({
      allowed: true,
    });
  });

  it("refuses the request that would cross it, and says by how much", () => {
    expect(
      decideAllowance({
        ...plan,
        used: 1_000,
        count: 1,
        resetsAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({
      allowed: false,
      reason: "allowance_exhausted",
      limit: 1_000,
      used: 1_000,
      resetsAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("keeps sending above the allowance when the plan bills overage", () => {
    expect(
      decideAllowance({
        limit: 1_000,
        used: 5_000,
        count: 1,
        overageEnabled: true,
        hardCap: 10_000,
      }),
    ).toEqual({ allowed: true });
  });

  it("STOPS at the hard cap even with overage enabled", () => {
    // The cap is an abuse control before it is a billing one: a compromised
    // key that bills $40,000 of overage is not a success case.
    expect(
      decideAllowance({
        limit: 1_000,
        used: 10_000,
        count: 1,
        overageEnabled: true,
        hardCap: 10_000,
      }),
    ).toEqual({
      allowed: false,
      reason: "allowance_exhausted",
      // The number that actually stopped them, not the included allowance —
      // "used 10000 of 1000" would be a refusal nobody could act on.
      limit: 10_000,
      used: 10_000,
    });
  });

  it("refuses a BATCH whole rather than admitting it over the ceiling", () => {
    // `count` is a parameter precisely so fifty messages cannot walk through a
    // gate with room for thirty.
    expect(decideAllowance({ ...plan, used: 970, count: 50 })).toMatchObject({
      allowed: false,
    });
    expect(decideAllowance({ ...plan, used: 950, count: 50 })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

describe("the relay meter — counts what was SENT (EARS 1, 2, 4)", () => {
  it("counts exactly one after a send succeeds", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "meter-one" }),
      { ses: fixture.ses, now: NOW },
    );

    expect(response.status).toBe(200);
    expect(await metered(fixture.environmentId)).toBe(1);
  });

  it("does NOT count a send that failed", async () => {
    const fixture = await seed();
    fixture.ses.failNext("sendEmail");

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "meter-failed" }),
      { ses: fixture.ses, now: NOW },
    );

    expect(response.status).toBe(503);
    expect(await metered(fixture.environmentId)).toBe(0);
  });

  it("does NOT count an idempotent replay", async () => {
    const fixture = await seed();

    for (const _ of [1, 2]) {
      const response = await handleRelaySend(
        sendRequest({ token: fixture.token, idempotencyKey: "meter-replay" }),
        { ses: fixture.ses, now: NOW },
      );
      expect(response.status).toBe(200);
    }

    // THE assertion of this PRD. Both calls answered 200 with the same id, so
    // only the counter can say whether the replay cost the customer a message.
    expect(await metered(fixture.environmentId)).toBe(1);
    expect(sendCalls(fixture.ses)).toBe(1);
  });

  it("counts a batch by what SENT, not by what was submitted", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const items = Array.from({ length: 10 }, (_, index) => ({
      idempotencyKey: `meter-batch-${index}`,
      to: index < 3 ? BAD_RECIPIENT : `ok-${index}@example.test`,
    }));

    const response = await handleRelaySendBatch(
      batchRequest(fixture.token, items),
      { ses: fixture.ses, now: NOW },
    );
    const body = (await response.json()) as {
      results: { status: string }[];
    };

    expect(response.status).toBe(200);
    expect(body.results.filter((row) => row.status === "sent")).toHaveLength(7);
    expect(await metered(fixture.environmentId)).toBe(7);
  });

  it("counts only the newly sent items when a partial batch is retried", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const items = [
      { idempotencyKey: "retry-a", to: "a@example.test" },
      { idempotencyKey: "retry-b", to: BAD_RECIPIENT },
    ];
    await handleRelaySendBatch(batchRequest(fixture.token, items), {
      ses: fixture.ses,
      now: NOW,
    });
    expect(await metered(fixture.environmentId)).toBe(1);

    // The address is fixed and the whole batch is retried. Item A replays (no
    // wire, no count); item B is the only new send.
    fixture.ses.reset();
    await makeSendReady(fixture.ses, sesTenantName(fixture.environmentId));
    const retry = await handleRelaySendBatch(
      batchRequest(fixture.token, [
        { idempotencyKey: "retry-a", to: "a@example.test" },
        { idempotencyKey: "retry-b", to: "b@example.test" },
      ]),
      { ses: fixture.ses, now: NOW },
    );

    expect(retry.status).toBe(200);
    expect(await metered(fixture.environmentId)).toBe(2);
  });

  it("never loses a count under concurrent increments", async () => {
    const fixture = await seed();

    // Twenty real, simultaneous upserts against the real unique index. A
    // read-then-write meter passes every sequential test in this file and
    // silently undercounts here — which is a revenue bug that never shows up
    // as an error.
    await Promise.all(
      Array.from({ length: 20 }, () => preloadUsage(fixture, 1)),
    );

    expect(await metered(fixture.environmentId)).toBe(20);
  });

  it("leaves the sweep's own columns alone", async () => {
    const fixture = await seed();
    await preloadUsage(fixture, 3);

    const [row] = await db
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.environmentId, fixture.environmentId),
          eq(usageCounters.month, MONTH),
        ),
      );

    // `emails_count` is the nightly sweep's ABSOLUTE column; the relay meter
    // writes its own, or the sweep would overwrite the month's billing every
    // night at 03:00.
    expect(row).toMatchObject({
      relayEmailsCount: 3,
      emailsCount: 0,
      eventsCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// The gate, at the relay
// ---------------------------------------------------------------------------

describe("the allowance gate at the relay (EARS 5, 6, 7)", () => {
  it("refuses at the hard cap without touching SES", async () => {
    const fixture = await seed();
    await preloadUsage(fixture, planLimits("trial").emailHardCap);

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "cap-refused" }),
      { ses: fixture.ses, now: NOW },
    );

    expect(response.status).toBe(402);
    const body = (await response.json()) as { limit: number; used: number };
    expect(body).toMatchObject({
      error: "allowance_exhausted",
      limit: planLimits("trial").emailHardCap,
    });
    // Org-wide, so it is at least this environment's preload: the refusal
    // reports what the ORGANIZATION has spent, not one environment's share.
    expect(body.used).toBeGreaterThanOrEqual(planLimits("trial").emailHardCap);
    expect(sendCalls(fixture.ses)).toBe(0);
    // Refused means refused: nothing was counted for a message nobody got.
    expect(await metered(fixture.environmentId)).toBe(
      planLimits("trial").emailHardCap,
    );
  });

  it("counts EVERY environment against the organization's one allowance", async () => {
    const a = await seed();
    const b = await seed();
    await preloadUsage(a, planLimits("trial").emailHardCap);

    // Otherwise the cap is a bypass one environment wide: send from staging.
    const response = await handleRelaySend(
      sendRequest({ token: b.token, idempotencyKey: "sibling-refused" }),
      { ses: b.ses, now: NOW },
    );

    expect(response.status).toBe(402);
    expect(sendCalls(b.ses)).toBe(0);
  });

  it("keeps sending above the included allowance on a plan that bills overage", async () => {
    const fixture = await seed(PAID_ORG);
    await preloadUsage(fixture, planLimits("self_serve").emailsPerMonth);

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "overage-allowed" }),
      { ses: fixture.ses, now: NOW },
    );

    expect(response.status).toBe(200);
    expect(await metered(fixture.environmentId)).toBe(
      planLimits("self_serve").emailsPerMonth + 1,
    );
  });

  it("reads the organization's usage across every environment", async () => {
    const a = await seed(PAID_ORG);
    const b = await seed(PAID_ORG);
    await preloadUsage(a, 5);
    await preloadUsage(b, 7);

    const used = await readRelayEmailsForPeriod(
      { organizationId: PAID_ORG, period: MONTH },
      db,
    );

    // Every environment seeded for PAID_ORG in this file contributes; the two
    // above are the only ones with usage besides the overage case.
    expect(used).toBeGreaterThanOrEqual(12);
  });

  it("is the gate the relay uses by DEFAULT", async () => {
    // The seam PRD 03 left is only closed if the relay resolves the real gate
    // with no dependency injected — which is what every test above relies on.
    const gate = createEmailAllowanceGate({ db });
    const fixture = await seed();
    await preloadUsage(fixture, planLimits("trial").emailHardCap);

    await expect(
      gate.canSend({
        environmentId: fixture.environmentId,
        organizationId: fixture.organizationId,
        count: 1,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
