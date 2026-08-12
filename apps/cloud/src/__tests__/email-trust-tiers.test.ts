import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailEvents,
  emailPauseHistory,
  environments,
  member,
  organization,
  organizations,
  user,
} from "../db/schema";
import { env } from "../env";
import {
  bounceRate,
  complaintRate,
  decideSuspension,
  decideTrustTier,
  ESTABLISHED_MAX_BOUNCE_RATE,
  ESTABLISHED_MAX_COMPLAINT_RATE,
  ESTABLISHED_MIN_DAYS,
  ESTABLISHED_MIN_DELIVERED,
  NEW_TIER_DAILY_CAP,
  SUSPEND_BOUNCE_RATE,
  SUSPEND_COMPLAINT_RATE,
  SUSPEND_MIN_VOLUME,
  tierReputationPolicy,
  tierSendCap,
  WATCHED_CAP_FRACTION,
} from "../lib/email-abuse-policy";
import { readEmailSendingView } from "../lib/email-abuse-view";
import { unlimitedAllowance } from "../lib/email-allowance";
import {
  decideBulkImport,
  handleBulkImportCheck,
} from "../lib/email-bulk-import";
import { handleRelaySend } from "../lib/email-relay";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import {
  formatNoticeTimestamp,
  renderSuspensionNotice,
} from "../lib/email-suspension-notice";
import { checkTierSendCap } from "../lib/email-tier-cap";
import {
  reconcileSendingStatus,
  sweepEmailReputation,
} from "../pipeline/reputation-sweep";
import {
  readEmailSendingStatus,
  recordEmailSendingStatus,
} from "../services/email-sending-status";
import {
  applyTrustTier,
  manuallySetTrustTier,
  readTrustTier,
  readTrustTierStats,
} from "../services/email-trust-tiers";
import { recordRelayEmails } from "../services/email-usage";
import { planLimits } from "../services/plan-limits";
import { RelayTokenService } from "../services/relay-tokens";
import { provisionSesTenant } from "../services/ses-tenants";
import { FakeSesClient } from "../ses/fake";
import { sesTenantName } from "../ses/names";
import { SesError, type SesReputationEntity } from "../ses/types";

/**
 * PRD 08 — trust tiers, the caps they set, and the bulk-import block.
 *
 * The published numbers in `docs/acceptable-use-policy.md` §5 and the code that
 * enforces them are the same numbers or the policy is a lie, so the first
 * describe here asserts the constants literally. Everything else drives a REAL
 * transition through the Fake rather than stubbing a return value.
 */

const ORG = "trust-tier-test-org";
const OWNER_ID = "trust-tier-owner";
const OWNER_EMAIL = "tier-owner@acme.test";
const PLAN_ALLOWANCE = planLimits("self_serve").emailsPerMonth;

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

const tokens = new RelayTokenService(db);
const NOW = new Date("2026-08-11T12:00:00.000Z");

let seq = 0;
let ses: FakeSesClient;
let sent: EmailMessage[];
let sender: EmailSender;

interface Fixture {
  environmentId: string;
  tenantName: string;
  token: string;
}

async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `tier-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  await provisionSesTenant(
    { environmentId: row.id },
    { db, ses, snsTopicArn: null },
  );
  const tenantName = sesTenantName(row.id);
  if (!ses.calls.some((call) => call.method === "createIdentity")) {
    await ses.createIdentity({ domain: DOMAIN });
    ses.__verifyIdentity(DOMAIN);
  }
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
  const { token } = await tokens.mint({ environmentId: row.id });
  return { environmentId: row.id, tenantName, token };
}

/** Park `count` relay sends on `daysAgo`, the way the meter records them. */
async function park(
  environmentId: string,
  daysAgo: number,
  count: number,
): Promise<void> {
  const at = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  await recordRelayEmails(
    { organizationId: ORG, environmentId, count, at },
    db,
  );
}

/** Park a terminal SES outcome, the way PRD 05's ingress records one. */
async function outcome(
  environmentId: string,
  type:
    | "email.delivered"
    | "email.bounced"
    | "email.complained"
    | "email.rejected",
  count: number,
  daysAgo = 1,
): Promise<void> {
  const at = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const rows = Array.from({ length: count }, (_, index) => ({
    environmentId,
    tenantName: sesTenantName(environmentId),
    region: "us" as const,
    dedupeKey: `tier-${environmentId}-${type}-${daysAgo}-${index}`,
    type,
    messageId: `msg-${index}`,
    payload: {},
    status: "delivered" as const,
    occurredAt: at,
  }));
  await db.insert(emailEvents).values(rows);
}

function sendRequest(token: string, key: string) {
  return new Request("http://localhost:3004/api/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
    },
    body: JSON.stringify({
      message: {
        from: `Acme <hello@${DOMAIN}>`,
        to: ["person@example.test"],
        subject: "Weekly digest",
        html: "<p>Hello</p>",
      },
    }),
  });
}

function importRequest(token: string | null, count = 5_000): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost:3004/api/email/bulk-import", {
    method: "POST",
    headers,
    body: JSON.stringify({ count }),
  });
}

async function cleanup(): Promise<void> {
  await db.delete(environments).where(eq(environments.organizationId, ORG));
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db.delete(organization).where(eq(organization.id, ORG));
  await db.delete(user).where(eq(user.id, OWNER_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Tier Org", region: "us", plan: "self_serve" });
  await db.insert(organization).values({ id: ORG, name: "Tier Org" });
  await db
    .insert(user)
    .values({ id: OWNER_ID, name: "Owner", email: OWNER_EMAIL });
  await db.insert(member).values({
    id: `${OWNER_ID}-member`,
    organizationId: ORG,
    userId: OWNER_ID,
    role: "owner",
  });
});

beforeEach(async () => {
  await db.delete(environments).where(eq(environments.organizationId, ORG));
  ses = new FakeSesClient({ region: "us" });
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
// The published numbers
// ---------------------------------------------------------------------------

describe("the constants published in AUP §5", () => {
  it("are exactly the numbers the policy states", () => {
    expect(SUSPEND_BOUNCE_RATE).toBe(0.05);
    expect(SUSPEND_COMPLAINT_RATE).toBe(0.001);
    expect(NEW_TIER_DAILY_CAP).toBe(500);
    expect(ESTABLISHED_MIN_DAYS).toBe(14);
    expect(ESTABLISHED_MIN_DELIVERED).toBe(1000);
    expect(ESTABLISHED_MAX_BOUNCE_RATE).toBe(0.02);
    expect(ESTABLISHED_MAX_COMPLAINT_RATE).toBe(0.0005);
    expect(WATCHED_CAP_FRACTION).toBe(0.25);
  });

  it("maps each tier to the reputation policy the table names", () => {
    expect(tierReputationPolicy("new")).toBe("NONE");
    expect(tierReputationPolicy("established")).toBe("STANDARD");
    expect(tierReputationPolicy("watched")).toBe("STRICT");
  });

  it("sets the cap the table names", () => {
    expect(tierSendCap({ tier: "new", planAllowance: PLAN_ALLOWANCE })).toEqual(
      { window: "day", limit: NEW_TIER_DAILY_CAP },
    );
    expect(
      tierSendCap({ tier: "watched", planAllowance: PLAN_ALLOWANCE }),
    ).toEqual({
      window: "period",
      limit: Math.floor(PLAN_ALLOWANCE * WATCHED_CAP_FRACTION),
    });
    // `established` is the plan allowance, which is the allowance gate's job.
    // A tier cap of its own would be a second ceiling saying the same thing.
    expect(
      tierSendCap({ tier: "established", planAllowance: PLAN_ALLOWANCE }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

describe("decideTrustTier", () => {
  const clean = {
    sendingDays: 20,
    sent: 5_000,
    delivered: 4_900,
    bounced: 50,
    complained: 1,
  };

  it("promotes a clean `new` tenant to established", () => {
    const decision = decideTrustTier({
      tier: "new",
      stats: clean,
      openFindings: 0,
    });
    expect(decision.tier).toBe("established");
    expect(decision.changed).toBe(true);
  });

  it("holds a tenant that has not sent for long enough", () => {
    const decision = decideTrustTier({
      tier: "new",
      stats: { ...clean, sendingDays: ESTABLISHED_MIN_DAYS - 1 },
      openFindings: 0,
    });
    expect(decision.tier).toBe("new");
    expect(decision.changed).toBe(false);
  });

  it("holds a tenant that has not delivered enough", () => {
    const decision = decideTrustTier({
      tier: "new",
      stats: { ...clean, delivered: ESTABLISHED_MIN_DELIVERED - 1 },
      openFindings: 0,
    });
    expect(decision.tier).toBe("new");
  });

  it("holds a tenant whose bounce rate is above the promotion ceiling", () => {
    // Comfortably clean, not merely not-yet-suspended: 3% is below the 5%
    // suspend threshold and still refuses promotion.
    const decision = decideTrustTier({
      tier: "new",
      stats: { ...clean, bounced: 150 },
      openFindings: 0,
    });
    expect(decision.tier).toBe("new");
  });

  it("holds a tenant whose complaint rate is above the promotion ceiling", () => {
    const decision = decideTrustTier({
      tier: "new",
      stats: { ...clean, complained: 10 },
      openFindings: 0,
    });
    expect(decision.tier).toBe("new");
  });

  it("demotes ANY tier to watched on an open finding", () => {
    for (const tier of ["new", "established", "watched"] as const) {
      const decision = decideTrustTier({
        tier,
        stats: clean,
        openFindings: 1,
      });
      expect(decision.tier).toBe("watched");
      expect(decision.changed).toBe(tier !== "watched");
    }
  });

  it("never promotes out of watched automatically", () => {
    const decision = decideTrustTier({
      tier: "watched",
      stats: clean,
      openFindings: 0,
    });
    expect(decision.tier).toBe("watched");
    expect(decision.changed).toBe(false);
    expect(decision.reason).toContain("human");
  });
});

describe("decideSuspension", () => {
  it("suspends at the published bounce rate", () => {
    const verdict = decideSuspension({
      sendingDays: 3,
      sent: 1_000,
      delivered: 940,
      bounced: 60,
      complained: 0,
    });
    expect(verdict.action).toBe("suspend");
    if (verdict.action !== "suspend") throw new Error("unreachable");
    expect(verdict.metric).toBe("hard bounce rate");
    expect(verdict.threshold).toBe(SUSPEND_BOUNCE_RATE);
    expect(verdict.clause).toBe("5.1");
  });

  it("suspends at the published complaint rate", () => {
    const verdict = decideSuspension({
      sendingDays: 3,
      sent: 10_000,
      delivered: 9_990,
      bounced: 0,
      complained: 10,
    });
    expect(verdict.action).toBe("suspend");
    if (verdict.action !== "suspend") throw new Error("unreachable");
    expect(verdict.metric).toBe("complaint rate");
  });

  it("does NOT suspend below a representative volume", () => {
    // One hard bounce on three messages is 33% and is not evidence of
    // anything. AUP §5.1 measures "over a representative volume".
    const verdict = decideSuspension({
      sendingDays: 1,
      sent: 3,
      delivered: 2,
      bounced: 1,
      complained: 0,
    });
    expect(verdict.action).toBe("none");
    expect(SUSPEND_MIN_VOLUME).toBeGreaterThan(3);
  });

  it("leaves a clean tenant alone", () => {
    const verdict = decideSuspension({
      sendingDays: 20,
      sent: 10_000,
      delivered: 9_950,
      bounced: 50,
      complained: 1,
    });
    expect(verdict.action).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// The notice copy (docs/hogsend-email-terms.md Part B)
// ---------------------------------------------------------------------------

describe("the suspension notice", () => {
  it("renders the token table's timestamp shape", () => {
    expect(formatNoticeTimestamp(new Date("2026-08-10T14:32:00Z"))).toBe(
      "10 August 2026 at 14:32 UTC",
    );
    // Midnight is 00:00, never 24:00 — the `hourCycle` this pins.
    expect(formatNoticeTimestamp(new Date("2026-08-10T00:00:00Z"))).toBe(
      "10 August 2026 at 00:00 UTC",
    );
  });

  it("renders the measured numbers when there are numbers", () => {
    const notice = renderSuspensionNotice({
      variant: "automatic",
      environment: "production",
      suspendedAt: new Date("2026-08-10T14:32:00Z"),
      clause: "5.1",
      cause: "Complaint rate crossed the review threshold.",
      measurement: {
        metric: "complaint rate",
        measured: 0.0031,
        threshold: SUSPEND_COMPLAINT_RATE,
        volume: 4180,
        window: "8 August to 10 August",
      },
    });

    expect(notice.subject).toBe("Sending suspended for production");
    // Rounded for a human, and NOT 0.3100000000000001%.
    expect(notice.text).toContain("complaint rate reached 0.31%");
    expect(notice.text).toContain("4,180 messages sent");
    expect(notice.text).toContain("The limit is 0.1%");
    expect(notice.text).toContain("clause 5.1");
  });

  it("omits the numbers sentence when the event carried none", () => {
    // An EventBridge pause carries a cause, not a rate. Printing "your
    // undefined reached undefined" would be worse than omitting the sentence.
    const notice = renderSuspensionNotice({
      variant: "automatic",
      environment: "production",
      suspendedAt: new Date("2026-08-10T14:32:00Z"),
      clause: "5.1",
      cause: "SES paused this tenant.",
    });

    expect(notice.text).not.toContain("reached");
    expect(notice.text).not.toContain("undefined");
    expect(notice.text).toContain("Recorded cause: SES paused this tenant.");
    // The way back is still there — that is the whole point of the notice.
    expect(notice.text).toContain("Reply to this email");
  });
});

// ---------------------------------------------------------------------------
// EARS 5 / 6 — the transition drives a real SES call
// ---------------------------------------------------------------------------

describe("applyTrustTier", () => {
  it("promotion sets the SES reputation policy to STANDARD", async () => {
    const a = await seed();
    const result = await applyTrustTier({
      environmentId: a.environmentId,
      tier: "established",
      reason: "clean sending record",
      db,
      ses,
    });

    expect(result.changed).toBe(true);
    expect(result.policy).toBe("STANDARD");
    expect(ses.__tenant(a.tenantName)?.reputationPolicy).toBe("STANDARD");
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "established",
    );
  });

  it("demotion sets it to STRICT", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "watched",
      reason: "reputation finding",
      db,
      ses,
    });
    expect(ses.__tenant(a.tenantName)?.reputationPolicy).toBe("STRICT");
  });

  it("re-asserting the same tier makes no SES call", async () => {
    const a = await seed();
    const before = ses.calls.filter(
      (call) => call.method === "setReputationPolicy",
    ).length;
    const result = await applyTrustTier({
      environmentId: a.environmentId,
      tier: "new",
      reason: "no change",
      db,
      ses,
    });
    const after = ses.calls.filter(
      (call) => call.method === "setReputationPolicy",
    ).length;

    expect(result.changed).toBe(false);
    expect(after).toBe(before);
  });
});

describe("manuallySetTrustTier", () => {
  it("refuses to promote out of watched while a finding is open", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "watched",
      reason: "finding",
      db,
      ses,
    });
    await db.insert((await import("../db/schema")).emailFindings).values({
      environmentId: a.environmentId,
      type: "COMPLAINT",
      impact: "HIGH",
      description: "still open",
      status: "open",
      openedAt: NOW,
    });

    const result = await manuallySetTrustTier({
      environmentId: a.environmentId,
      tier: "established",
      actor: "operator@hogsend.com",
      db,
      ses,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("open_findings");
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "watched",
    );
  });

  it("allows a human to promote once the findings are resolved", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "watched",
      reason: "finding",
      db,
      ses,
    });

    const result = await manuallySetTrustTier({
      environmentId: a.environmentId,
      tier: "established",
      actor: "operator@hogsend.com",
      db,
      ses,
    });

    expect(result.ok).toBe(true);
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "established",
    );
    expect(ses.__tenant(a.tenantName)?.reputationPolicy).toBe("STANDARD");
  });
});

// ---------------------------------------------------------------------------
// EARS 5 — the send cap, keyed on tier
// ---------------------------------------------------------------------------

describe("tier send cap", () => {
  it("refuses a `new` tenant past its daily cap", async () => {
    const a = await seed();
    await park(a.environmentId, 0, NEW_TIER_DAILY_CAP);

    const verdict = await checkTierSendCap({
      environmentId: a.environmentId,
      organizationId: ORG,
      count: 1,
      now: NOW,
      db,
    });

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toBe("tier_cap_exceeded");
    expect(verdict.limit).toBe(NEW_TIER_DAILY_CAP);
    expect(verdict.window).toBe("day");
  });

  it("weighs the WHOLE request, not one message at a time", async () => {
    const a = await seed();
    await park(a.environmentId, 0, NEW_TIER_DAILY_CAP - 10);

    const verdict = await checkTierSendCap({
      environmentId: a.environmentId,
      organizationId: ORG,
      count: 50,
      now: NOW,
      db,
    });
    expect(verdict.allowed).toBe(false);
  });

  it("yesterday's sends do not count against today", async () => {
    const a = await seed();
    await park(a.environmentId, 1, NEW_TIER_DAILY_CAP);

    const verdict = await checkTierSendCap({
      environmentId: a.environmentId,
      organizationId: ORG,
      count: 1,
      now: NOW,
      db,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("an established tenant has no tier cap at all", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "established",
      reason: "clean",
      db,
      ses,
    });
    await park(a.environmentId, 0, NEW_TIER_DAILY_CAP * 10);

    const verdict = await checkTierSendCap({
      environmentId: a.environmentId,
      organizationId: ORG,
      count: 1,
      now: NOW,
      db,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("a watched tenant is capped at a fraction of the plan allowance", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "watched",
      reason: "finding",
      db,
      ses,
    });
    const cap = Math.floor(PLAN_ALLOWANCE * WATCHED_CAP_FRACTION);
    await park(a.environmentId, 0, cap);

    const verdict = await checkTierSendCap({
      environmentId: a.environmentId,
      organizationId: ORG,
      count: 1,
      now: NOW,
      db,
    });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.limit).toBe(cap);
    expect(verdict.window).toBe("period");
  });

  it("the relay refuses over the cap, and never reaches the wire", async () => {
    const a = await seed();
    await park(a.environmentId, 0, NEW_TIER_DAILY_CAP);

    const response = await handleRelaySend(sendRequest(a.token, "cap-1"), {
      db,
      ses,
      allowance: unlimitedAllowance,
      now: NOW,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("tier_cap_exceeded");
    expect(String(body.message)).toContain("new");
    expect(
      ses.calls.filter((call) => call.method === "sendEmail"),
    ).toHaveLength(0);
  });

  it("does not cap an environment with no SES tenancy", async () => {
    // A deliberate answer, not an oversight: the cap bounds what one SES
    // TENANT can do to the shared pool, and there is no tenant here — a send
    // would be refused by SES itself. Nothing real reaches this branch, because
    // the tenancy row and the relay token are written in one transaction.
    seq += 1;
    const [row] = await db
      .insert(environments)
      .values({ organizationId: ORG, name: `no-tenancy-${seq}`, kind: "test" })
      .returning();
    if (!row) throw new Error("failed to seed environment");
    await park(row.id, 0, NEW_TIER_DAILY_CAP * 100);

    const verdict = await checkTierSendCap({
      environmentId: row.id,
      organizationId: ORG,
      count: 1,
      now: NOW,
      db,
    });
    expect(verdict.allowed).toBe(true);
  });

  it("the relay lets a tenant under its cap through", async () => {
    const a = await seed();
    await park(a.environmentId, 0, 10);

    const response = await handleRelaySend(sendRequest(a.token, "cap-2"), {
      db,
      ses,
      allowance: unlimitedAllowance,
      now: NOW,
    });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// EARS 7 — the bulk-import block
// ---------------------------------------------------------------------------

describe("bulk import", () => {
  it("is blocked for `new` with a reason naming the tier requirement", () => {
    const verdict = decideBulkImport({ tier: "new" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("bulk_import_blocked");
    expect(verdict.requiredTier).toBe("established");
    expect(verdict.message).toContain("established");
  });

  it("is blocked for `watched`", () => {
    expect(decideBulkImport({ tier: "watched" }).allowed).toBe(false);
  });

  it("is allowed for `established`", () => {
    expect(decideBulkImport({ tier: "established" }).allowed).toBe(true);
  });

  it("the endpoint refuses a `new` tenant with 403 and the tier named", async () => {
    const a = await seed();
    const response = await handleBulkImportCheck(importRequest(a.token), {
      db,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("bulk_import_blocked");
    expect(body.tier).toBe("new");
    expect(body.requiredTier).toBe("established");
    expect(String(body.message)).toContain("established");
  });

  it("the endpoint admits an established tenant", async () => {
    const a = await seed();
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "established",
      reason: "clean",
      db,
      ses,
    });

    const response = await handleBulkImportCheck(importRequest(a.token), {
      db,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).allowed).toBe(true);
  });

  it("refuses an unauthenticated caller before it decides anything", async () => {
    const response = await handleBulkImportCheck(importRequest(null), { db });
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe("reputation sweep", () => {
  it("promotes a tenant that meets every criterion", async () => {
    const a = await seed();
    for (let day = 1; day <= ESTABLISHED_MIN_DAYS; day += 1) {
      await park(a.environmentId, day, 200);
    }
    // Every criterion, and no more than every criterion: the day count, the
    // delivered floor, and both rates comfortably inside the promotion
    // ceilings (10/2800 bounce, zero complaints).
    await outcome(
      a.environmentId,
      "email.delivered",
      ESTABLISHED_MIN_DELIVERED,
    );
    await outcome(a.environmentId, "email.bounced", 10);

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(result.promoted.map((row) => row.environmentId)).toContain(
      a.environmentId,
    );
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "established",
    );
    expect(ses.__tenant(a.tenantName)?.reputationPolicy).toBe("STANDARD");
  });

  it("leaves a tenant with too short a record on `new`", async () => {
    const a = await seed();
    for (let day = 1; day <= 3; day += 1) await park(a.environmentId, day, 500);
    await outcome(a.environmentId, "email.delivered", 60);

    await sweepEmailReputation({ db, ses, sender, now: NOW });
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "new",
    );
  });

  it("suspends a tenant over the published bounce rate, and notifies", async () => {
    const a = await seed();
    await park(a.environmentId, 1, 1_000);
    await outcome(a.environmentId, "email.delivered", 60);
    await outcome(a.environmentId, "email.bounced", 60);

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(result.suspended.map((row) => row.environmentId)).toContain(
      a.environmentId,
    );
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("enforced");
    expect(status.reason).toContain("bounce");
    // The seam verb an operator stop goes through, on the settled client.
    expect(ses.__tenant(a.tenantName)?.sendingStatus).toBe("DISABLED");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OWNER_EMAIL);
    expect(sent[0]?.text).toContain("clause 5.1");
  });

  it("suspends the offender and leaves its neighbour sending", async () => {
    const bad = await seed();
    const good = await seed();
    await park(bad.environmentId, 1, 1_000);
    await outcome(bad.environmentId, "email.delivered", 60);
    await outcome(bad.environmentId, "email.bounced", 60);
    await park(good.environmentId, 1, 1_000);
    await outcome(good.environmentId, "email.delivered", 120);

    await sweepEmailReputation({ db, ses, sender, now: NOW });

    const badStatus = await readEmailSendingStatus({
      environmentId: bad.environmentId,
      db,
    });
    const goodStatus = await readEmailSendingStatus({
      environmentId: good.environmentId,
      db,
    });
    expect(badStatus.status).toBe("enforced");
    expect(goodStatus.status).toBe("active");
  });

  it("does not re-notify a tenant it already suspended", async () => {
    const a = await seed();
    await park(a.environmentId, 1, 1_000);
    await outcome(a.environmentId, "email.delivered", 60);
    await outcome(a.environmentId, "email.bounced", 60);

    await sweepEmailReputation({ db, ses, sender, now: NOW });
    await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(sent).toHaveLength(1);
  });

  it("never suspends below a representative volume", async () => {
    const a = await seed();
    await park(a.environmentId, 1, 5);
    await outcome(a.environmentId, "email.bounced", 3);

    await sweepEmailReputation({ db, ses, sender, now: NOW });
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("active");
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The reconciliation read
//
// `docs/ses-production-access-request.md` calls `ses:GetReputationEntity` "the
// reconciliation path for a missed EventBridge event", and says that without it
// "a missed pause leaves a tenant looking active in our mirrored status, and
// since the relay reads that mirror, the failure mode is fail-OPEN". These
// tests are that sentence, executed.
// ---------------------------------------------------------------------------

describe("reconcileSendingStatus", () => {
  const entity = (
    overrides: Partial<SesReputationEntity> = {},
  ): SesReputationEntity => ({
    reference: "arn:aws:ses:us-east-1:000000000000:tenant/env-x",
    sendingStatus: "ENABLED",
    ...overrides,
  });

  it("repairs the fail-OPEN direction: mirror active, AWS disabled", () => {
    const decision = reconcileSendingStatus(
      "active",
      entity({
        sendingStatus: "DISABLED",
        awsSesManagedStatus: {
          status: "DISABLED",
          cause: "Your bounce rate is too high.",
        },
      }),
    );
    expect(decision?.status).toBe("paused");
    expect(decision?.reason).toContain("bounce rate");
  });

  it("names OUR stop `enforced` when the customer record is the disabler", () => {
    const decision = reconcileSendingStatus(
      "active",
      entity({
        sendingStatus: "DISABLED",
        customerManagedStatus: { status: "DISABLED" },
      }),
    );
    expect(decision?.status).toBe("enforced");
  });

  it("leaves a mirror that already blocks alone, whoever stopped it", () => {
    const stopped = entity({
      sendingStatus: "DISABLED",
      customerManagedStatus: { status: "DISABLED" },
    });
    expect(reconcileSendingStatus("enforced", stopped)).toBeNull();
    expect(reconcileSendingStatus("paused", stopped)).toBeNull();
  });

  it("reinstates a paused mirror AWS has let back on", () => {
    expect(reconcileSendingStatus("paused", entity())?.status).toBe(
      "reinstated",
    );
    expect(
      reconcileSendingStatus("paused", entity({ sendingStatus: "REINSTATED" }))
        ?.status,
    ).toBe("reinstated");
  });

  it("never unblocks OUR enforcement — that stop is not AWS's to reverse", () => {
    expect(reconcileSendingStatus("enforced", entity())).toBeNull();
    expect(
      reconcileSendingStatus(
        "enforced",
        entity({ sendingStatus: "REINSTATED" }),
      ),
    ).toBeNull();
  });

  it("adds a pause we missed entirely, and never erases one we recorded", () => {
    // Both agree the tenant may send; only AWS remembers the pause.
    expect(
      reconcileSendingStatus("active", entity({ sendingStatus: "REINSTATED" }))
        ?.status,
    ).toBe("reinstated");
    // The mirror remembers a pause AWS's entity no longer names. Demoting it to
    // `active` would erase history to reach a state that permits the same sends.
    expect(reconcileSendingStatus("reinstated", entity())).toBeNull();
  });

  it("refuses to move the mirror when AWS reported no status at all", () => {
    expect(
      reconcileSendingStatus("active", entity({ sendingStatus: undefined })),
    ).toBeNull();
  });
});

describe("the reputation sweep's reconciliation", () => {
  it("repairs a mirror still reporting a paused tenant as active", async () => {
    const a = await seed();
    ses.__pauseTenant(a.tenantName, "Your bounce rate is too high.");

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(
      ses.calls.filter((call) => call.method === "getReputationEntity"),
    ).not.toHaveLength(0);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
    expect(status.reason).toContain("bounce rate");
    expect(result.reconciled).toContainEqual({
      environmentId: a.environmentId,
      from: "active",
      to: "paused",
    });
  });

  it("records the repair in the pause history as `reconcile`", async () => {
    const a = await seed();
    ses.__pauseTenant(a.tenantName, "Your complaint rate is too high.");

    await sweepEmailReputation({ db, ses, sender, now: NOW });

    const history = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(history).toHaveLength(1);
    expect(history[0]?.source).toBe("reconcile");
    expect(history[0]?.status).toBe("paused");
  });

  it("writes nothing on a second pass, because the mirror now agrees", async () => {
    const a = await seed();
    ses.__pauseTenant(a.tenantName);

    await sweepEmailReputation({ db, ses, sender, now: NOW });
    await sweepEmailReputation({ db, ses, sender, now: NOW });

    const history = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(history).toHaveLength(1);
  });

  it("reconciles BEFORE it decides, so AWS's pause is not re-decided as ours", async () => {
    const a = await seed();
    // Over the published bounce rate: the sweep would suspend this tenant
    // itself if it had not first learned that AWS already stopped it.
    await park(a.environmentId, 1, 1_000);
    await outcome(a.environmentId, "email.delivered", 60);
    await outcome(a.environmentId, "email.bounced", 60);
    ses.__pauseTenant(a.tenantName, "Your bounce rate is too high.");

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
    expect(result.suspended).toHaveLength(0);
  });

  it("moves a paused mirror to reinstated once SES lets the tenant back on", async () => {
    const a = await seed();
    ses.__pauseTenant(a.tenantName);
    await sweepEmailReputation({ db, ses, sender, now: NOW });

    ses.__resumeTenant(a.tenantName);
    await sweepEmailReputation({ db, ses, sender, now: NOW });

    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("reinstated");
  });

  it("does not walk OUR enforcement back when AWS reports the tenant enabled", async () => {
    const a = await seed();
    await recordEmailSendingStatus({
      environmentId: a.environmentId,
      status: "enforced",
      reason: "operator stop",
      db,
    });

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    // The read HAPPENED — this is not passing because nothing was reconciled.
    expect(
      ses.calls.filter(
        (call) =>
          call.method === "getReputationEntity" &&
          (call.args[0] as { tenantName?: string })?.tenantName ===
            a.tenantName,
      ),
    ).toHaveLength(1);
    expect(result.reconciled).toHaveLength(0);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("enforced");
  });

  it("passes the stored ARN, so it never pays a lookup to relearn one", async () => {
    const a = await seed();

    await sweepEmailReputation({ db, ses, sender, now: NOW });

    const call = ses.calls.find(
      (entry) =>
        entry.method === "getReputationEntity" &&
        (entry.args[0] as { tenantName?: string })?.tenantName === a.tenantName,
    );
    expect((call?.args[0] as { tenantArn?: string })?.tenantArn).toBe(
      ses.__tenant(a.tenantName)?.arn,
    );
  });

  it("skips a tenancy AWS has never heard of rather than failing the tenant", async () => {
    await seed();
    // The supported no-credentials default: a row the Fake minted, which no
    // real reputation entity backs. It is not a sweep failure, and it must not
    // be retried as one every hour for the life of the deploy.
    ses.reset();

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(
      ses.calls.filter((call) => call.method === "getReputationEntity"),
    ).not.toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.reconcileFailed).toHaveLength(0);
    expect(result.reconciled).toHaveLength(0);
  });

  it("never clears a pause the relay recorded for an ACCOUNT-level stop", async () => {
    const a = await seed();
    // The relay met AccountSuspendedException at the wire and mirrored it. The
    // TENANT's reputation entity has nothing against this tenant — an
    // account-level stop never shows there — so AWS answers ENABLED, which is
    // no authority to clear a stop that was never about the tenant.
    await recordEmailSendingStatus({
      environmentId: a.environmentId,
      status: "paused",
      reason: "The sending account is suspended: enforcement",
      source: "relay",
      at: NOW,
      db,
    });

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(result.reconciled).toHaveLength(0);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
    // And no false "SES reports this tenant may send again" row in the
    // history a human reads during an appeal.
    const history = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(history.map((row) => row.status)).toEqual(["paused"]);
  });

  it("still clears a relay-recorded TENANT pause once AWS lets it back on", async () => {
    const a = await seed();
    // Same writer, tenant scope: the relay met TenantSendingPaused at the
    // wire. The tenant's own entity IS the authority over this one.
    await recordEmailSendingStatus({
      environmentId: a.environmentId,
      status: "paused",
      reason: "SES paused this tenant: Your bounce rate is too high.",
      source: "relay",
      at: NOW,
      db,
    });

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    expect(result.reconciled).toContainEqual({
      environmentId: a.environmentId,
      from: "paused",
      to: "reinstated",
    });
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("reinstated");
  });

  it("records a failed read-back and still runs the tenant's own evaluation", async () => {
    const a = await seed();
    // Over the published bounce rate — the LOCAL decision that must survive a
    // dead reconcile, because this sweep is the only enforcement a `new`-tier
    // tenant has.
    await park(a.environmentId, 1, 1_000);
    await outcome(a.environmentId, "email.delivered", 60);
    await outcome(a.environmentId, "email.bounced", 60);
    ses.failNext("getReputationEntity");

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    // Recorded as a reconcile failure, NOT as a failed evaluation…
    expect(result.reconcileFailed).toContainEqual({
      environmentId: a.environmentId,
      error: expect.stringContaining("getReputationEntity"),
    });
    expect(result.failed).toHaveLength(0);
    // …because the suspension backstop still ran on the mirror we hold.
    expect(result.suspended.map((row) => row.environmentId)).toContain(
      a.environmentId,
    );
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("enforced");
  });

  it("skips reconciliation on not_found and the evaluation still completes", async () => {
    const a = await seed();
    // Promotion-worthy, so the tier leg PROVABLY ran after the skip — this and
    // the test above are the pair that distinguishes "swallow not_found" from
    // "swallow everything".
    for (let day = 1; day <= ESTABLISHED_MIN_DAYS; day += 1) {
      await park(a.environmentId, day, 200);
    }
    await outcome(
      a.environmentId,
      "email.delivered",
      ESTABLISHED_MIN_DELIVERED,
    );
    ses.failNext(
      "getReputationEntity",
      new SesError("fake SES: no reputation entity", {
        kind: "not_found",
        operation: "getReputationEntity",
      }),
    );

    const result = await sweepEmailReputation({ db, ses, sender, now: NOW });

    // A no-credentials deploy is not a failure: NEITHER list may name it.
    expect(result.reconcileFailed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.promoted.map((row) => row.environmentId)).toContain(
      a.environmentId,
    );
  });
});

describe("readTrustTierStats", () => {
  it("counts sending days, sends and terminal outcomes in the window", async () => {
    const a = await seed();
    await park(a.environmentId, 1, 100);
    await park(a.environmentId, 2, 100);
    await park(a.environmentId, 2, 50);
    await outcome(a.environmentId, "email.delivered", 40);
    await outcome(a.environmentId, "email.bounced", 2);
    await outcome(a.environmentId, "email.complained", 1);

    const stats = await readTrustTierStats({
      environmentId: a.environmentId,
      now: NOW,
      db,
    });

    expect(stats.sendingDays).toBe(2);
    expect(stats.sent).toBe(250);
    expect(stats.delivered).toBe(40);
    expect(stats.bounced).toBe(2);
    expect(stats.complained).toBe(1);
  });

  it("counts a reject toward NOTHING — not the bounce rate, not delivered", async () => {
    // PRD 18. A reject is OUR content failing, not the recipient's address
    // failing, so it must not move the number that pauses a tenant. The rates
    // are computed by TYPE off `email_events`, which is exactly why the neutral
    // type had to be its own rather than an `email.bounced` variant.
    const a = await seed();
    await park(a.environmentId, 1, 100);
    await outcome(a.environmentId, "email.delivered", 40);
    await outcome(a.environmentId, "email.rejected", 30);

    const stats = await readTrustTierStats({
      environmentId: a.environmentId,
      now: NOW,
      db,
    });

    expect(stats.bounced).toBe(0);
    expect(stats.complained).toBe(0);
    expect(stats.delivered).toBe(40);
    expect(bounceRate(stats)).toBe(0);
    expect(complaintRate(stats)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EARS 8 — the operator view
// ---------------------------------------------------------------------------

describe("the operator view", () => {
  it("shows status, tier, cap, open findings and pause history", async () => {
    const a = await seed();
    await park(a.environmentId, 0, 25);
    await applyTrustTier({
      environmentId: a.environmentId,
      tier: "watched",
      reason: "finding",
      db,
      ses,
    });
    await db.insert((await import("../db/schema")).emailFindings).values({
      environmentId: a.environmentId,
      type: "COMPLAINT",
      impact: "HIGH",
      description: "Complaint rate is climbing.",
      status: "open",
      openedAt: NOW,
    });
    await db.insert((await import("../db/schema")).emailPauseHistory).values({
      environmentId: a.environmentId,
      status: "paused",
      reason: "SES paused this tenant",
      source: "eventbridge",
      at: NOW,
    });

    const view = await readEmailSendingView({
      environmentId: a.environmentId,
      organizationId: ORG,
      now: NOW,
      db,
    });
    if (!view) throw new Error("expected a view for a provisioned tenancy");

    expect(view.tier).toBe("watched");
    expect(view.status).toBe("active");
    expect(view.cap?.limit).toBe(
      Math.floor(PLAN_ALLOWANCE * WATCHED_CAP_FRACTION),
    );
    expect(view.usedInCapWindow).toBe(25);
    expect(view.bulkImportAllowed).toBe(false);
    expect(view.openFindings).toHaveLength(1);
    expect(view.openFindings[0]?.type).toBe("COMPLAINT");
    expect(view.pauseHistory).toHaveLength(1);
    expect(view.pauseHistory[0]?.source).toBe("eventbridge");
  });

  it("is null for an environment with no Hogsend Email tenancy", async () => {
    seq += 1;
    const [row] = await db
      .insert(environments)
      .values({ organizationId: ORG, name: `no-ses-${seq}`, kind: "test" })
      .returning();
    if (!row) throw new Error("failed to seed environment");

    const view = await readEmailSendingView({
      environmentId: row.id,
      organizationId: ORG,
      now: NOW,
      db,
    });
    expect(view).toBeNull();
  });
});
