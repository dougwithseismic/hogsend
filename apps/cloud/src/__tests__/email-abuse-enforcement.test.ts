import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailAbuseEvents,
  emailFindings,
  emailPauseHistory,
  environments,
  member,
  organization,
  organizations,
  user,
} from "../db/schema";
import { env } from "../env";
import {
  EVENTBRIDGE_SECRET_HEADER,
  EventBridgeVerificationError,
  verifyEventBridgeSecret,
} from "../eventbridge/verify";
import { handleSesAbuseEvent } from "../lib/email-abuse-ingress";
import { unlimitedAllowance } from "../lib/email-allowance";
import { handleRelaySend } from "../lib/email-relay";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import {
  reinstateEmailSending,
  suspendEmailSending,
} from "../services/email-enforcement";
import {
  readEmailSendingStatus,
  recordEmailSendingStatus,
} from "../services/email-sending-status";
import { readTrustTier } from "../services/email-trust-tiers";
import { RelayTokenService } from "../services/relay-tokens";
import { provisionSesTenant } from "../services/ses-tenants";
import { FakeSesClient } from "../ses/fake";
import { sesTenantName } from "../ses/names";
import {
  advisorRecommendationClosed,
  advisorRecommendationOpen,
  eventBridgeId,
  sendingStatusDisabled,
  sendingStatusEnabled,
} from "./helpers/eventbridge-events";

/**
 * PRD 08 — the EventBridge ingress, the state it mirrors, and the notice it
 * sends.
 *
 * The claim this whole architecture is bought with is CROSS-TENANT ISOLATION:
 * stopping one tenant must leave every other one sending. A suite that never
 * checks it certifies nothing, so that proof is here first and is made against
 * the FAKE'S CALL LOG — the only honest record of whether a message reached the
 * wire.
 *
 * No test here reaches AWS or the network. Every SES call goes through
 * `FakeSesClient` and every email through a spy `EmailSender`.
 */

const ORG = "abuse-enforcement-test-org";
const OWNER_ID = "abuse-enforcement-owner";
const OWNER_EMAIL = "owner@acme.test";
const SECRET = "eventbridge-shared-secret";

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

const tokens = new RelayTokenService(db);

let seq = 0;
let sent: EmailMessage[];
let sender: EmailSender;

interface Fixture {
  environmentId: string;
  tenantName: string;
  token: string;
  ses: FakeSesClient;
}

/**
 * A fully provisioned environment: an SES tenancy row, a relay token, and a
 * Fake in the state a real provision leaves it in.
 *
 * `provisionSesTenant` is used rather than hand-inserting rows so the tier
 * column's default and the tenancy the ingress resolves through are the ones
 * production actually writes.
 */
async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `abuse-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");

  const ses = new FakeSesClient({ region: "us" });
  await provisionSesTenant(
    { environmentId: row.id },
    { db, ses, snsTopicArn: null },
  );
  // The Fake enforces the wire's sender-side preconditions (PRD 02's note): a
  // send needs a VERIFIED identity ASSOCIATED with the tenant.
  const tenantName = sesTenantName(row.id);
  await ses.createIdentity({ domain: DOMAIN });
  ses.__verifyIdentity(DOMAIN);
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });

  // Provisioning mints a token; mint a fresh one we hold the plaintext of.
  const { token } = await tokens.mint({ environmentId: row.id });
  return { environmentId: row.id, tenantName, token, ses };
}

function abuseRequest(payload: unknown, secret = SECRET): Request {
  return new Request("http://localhost:3004/api/email/reputation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [EVENTBRIDGE_SECRET_HEADER]: secret,
    },
    body: JSON.stringify(payload),
  });
}

function deps(overrides: Record<string, unknown> = {}) {
  return { db, secret: SECRET, sender, now: new Date(), ...overrides };
}

function sendRequest(token: string, key = `idem-${seq}-${Math.random()}`) {
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

function sendCalls(ses: FakeSesClient): number {
  return ses.calls.filter((call) => call.method === "sendEmail").length;
}

/**
 * Retire the journal rows for events that resolved to NOBODY.
 *
 * They are the one thing here that does not cascade, deliberately: an
 * unresolved event has a null `environment_id` precisely so it survives the
 * environment's deletion (it is evidence of a provisioning gap). That is
 * correct in production and is a fixture leak in a suite, because the unique
 * index on `event_id` would make the next run's identically-numbered event a
 * "duplicate" and quietly certify the opposite of what the test asserts.
 */
async function forgetOrphanEvents(): Promise<void> {
  await db
    .delete(emailAbuseEvents)
    .where(isNull(emailAbuseEvents.environmentId));
}

async function cleanup(): Promise<void> {
  await db.delete(environments).where(eq(environments.organizationId, ORG));
  await forgetOrphanEvents();
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db.delete(organization).where(eq(organization.id, ORG));
  await db.delete(user).where(eq(user.id, OWNER_ID));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Abuse Org", region: "us", plan: "self_serve" });
  await db.insert(organization).values({ id: ORG, name: "Abuse Org" });
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
  // Environments cascade their tenancy, status, findings, history and events.
  await db.delete(environments).where(eq(environments.organizationId, ORG));
  await forgetOrphanEvents();
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
// The claim the architecture is bought with
// ---------------------------------------------------------------------------

describe("cross-tenant isolation", () => {
  it("pausing tenant A leaves tenant B sending", async () => {
    const a = await seed();
    const b = await seed();

    const response = await handleSesAbuseEvent(
      abuseRequest(
        sendingStatusDisabled({
          tenantName: a.tenantName,
          cause: "Hard bounce rate of 7.2% over 4,180 messages.",
        }),
      ),
      deps({ ses: a.ses }),
    );
    expect(response.status).toBe(200);

    // A is stopped, and the reason is the one AWS gave.
    const refused = await handleRelaySend(sendRequest(a.token), {
      db,
      ses: a.ses,
      allowance: unlimitedAllowance,
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body.error).toBe("tenant_paused");
    expect(String(body.reason)).toContain("7.2%");
    expect(sendCalls(a.ses)).toBe(0);

    // B never heard about it.
    const allowed = await handleRelaySend(sendRequest(b.token), {
      db,
      ses: b.ses,
      allowance: unlimitedAllowance,
    });
    expect(allowed.status).toBe(200);
    expect(sendCalls(b.ses)).toBe(1);

    const bStatus = await readEmailSendingStatus({
      environmentId: b.environmentId,
      db,
    });
    expect(bStatus.status).toBe("active");
    expect(bStatus.reason).toBeNull();
  });

  it("only the named tenant's status row is written", async () => {
    const a = await seed();
    const b = await seed();

    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    const aStatus = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    const bStatus = await readEmailSendingStatus({
      environmentId: b.environmentId,
      db,
    });
    expect(aStatus.status).toBe("paused");
    expect(bStatus.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// EARS 1 — Sending Status Disabled
// ---------------------------------------------------------------------------

describe("Sending Status Disabled", () => {
  it("mirrors the pause with the event's cause and timestamp", async () => {
    const a = await seed();
    const payload = sendingStatusDisabled({
      tenantName: a.tenantName,
      cause: "Complaint rate of 0.31% exceeded the review threshold.",
      time: "2026-08-11T09:30:00Z",
    });

    await handleSesAbuseEvent(abuseRequest(payload), deps({ ses: a.ses }));

    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
    expect(status.reason).toContain("0.31%");
    expect(status.pausedAt?.toISOString()).toBe("2026-08-11T09:30:00.000Z");
  });

  it("records the transition in pause history", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    const rows = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("paused");
    expect(rows[0]?.source).toBe("eventbridge");
  });

  it("Sending Status Enabled reinstates, and history keeps both", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusEnabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    // `reinstated`, never `active`: "has this tenant ever been stopped" has to
    // survive the recovery.
    expect(status.status).toBe("reinstated");

    const rows = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId))
      .orderBy(emailPauseHistory.at);
    expect(rows.map((row) => row.status)).toEqual(["paused", "reinstated"]);
  });
});

// ---------------------------------------------------------------------------
// EARS 2 — Advisor Recommendation Status Open
// ---------------------------------------------------------------------------

describe("Advisor Recommendation Status Open", () => {
  it("records the finding and demotes the tenant to watched", async () => {
    const a = await seed();
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "new",
    );

    await handleSesAbuseEvent(
      abuseRequest(
        advisorRecommendationOpen({
          tenantName: a.tenantName,
          type: "COMPLAINT",
          impact: "HIGH",
          description: "Complaint rate is trending toward the pause level.",
        }),
      ),
      deps({ ses: a.ses }),
    );

    const findings = await db
      .select()
      .from(emailFindings)
      .where(eq(emailFindings.environmentId, a.environmentId));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe("COMPLAINT");
    expect(findings[0]?.impact).toBe("HIGH");
    expect(findings[0]?.description).toContain("Complaint rate");
    expect(findings[0]?.status).toBe("open");

    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "watched",
    );
  });

  it("a finding does not pause sending — only status gates the wire", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(advisorRecommendationOpen({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("active");
  });

  it("sets the SES reputation policy to STRICT on demotion", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(advisorRecommendationOpen({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    expect(a.ses.__tenant(a.tenantName)?.reputationPolicy).toBe("STRICT");
  });

  it("closing a finding does NOT promote out of watched", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(advisorRecommendationOpen({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );
    await handleSesAbuseEvent(
      abuseRequest(advisorRecommendationClosed({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    const findings = await db
      .select()
      .from(emailFindings)
      .where(eq(emailFindings.environmentId, a.environmentId));
    expect(findings[0]?.status).toBe("fixed");
    // Promotion out of `watched` is a human review. An automatic one is an
    // automatic bypass.
    expect(await readTrustTier({ environmentId: a.environmentId, db })).toBe(
      "watched",
    );
  });
});

// ---------------------------------------------------------------------------
// EARS 3 — the suspension notice, exactly once per pause event
// ---------------------------------------------------------------------------

describe("suspension notice", () => {
  it("goes to the environment owner once, citing the clause", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(OWNER_EMAIL);
    expect(sent[0]?.subject).toContain("Sending suspended for");
    expect(sent[0]?.text).toContain("clause 5.1");
    expect(sent[0]?.text).toContain("Recorded cause:");
  });

  it("a redelivered EventBridge event does not re-notify", async () => {
    const a = await seed();
    const id = eventBridgeId("redelivery");
    const payload = sendingStatusDisabled({ tenantName: a.tenantName, id });

    const first = await handleSesAbuseEvent(
      abuseRequest(payload),
      deps({ ses: a.ses }),
    );
    const second = await handleSesAbuseEvent(
      abuseRequest(payload),
      deps({ ses: a.ses }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).action).toBe("duplicate");
    expect(sent).toHaveLength(1);

    // And exactly one journal row and one history row survive the redelivery.
    const events = await db
      .select()
      .from(emailAbuseEvents)
      .where(eq(emailAbuseEvents.eventId, id));
    expect(events).toHaveLength(1);
    const history = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(history).toHaveLength(1);
  });

  it("a DISTINCT second pause event notifies again", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusEnabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    expect(sent).toHaveLength(2);
  });

  it("a failed notice leaves the pause in place", async () => {
    const a = await seed();
    const failing: EmailSender = {
      id: "failing",
      async send() {
        throw new Error("smtp is down");
      },
    };

    const response = await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses, sender: failing }),
    );

    expect(response.status).toBe(200);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// EARS 4 — the recorded cause survives to the journey
// ---------------------------------------------------------------------------

describe("fail closed with the recorded cause", () => {
  it("the relay's refusal carries the recorded sentence verbatim", async () => {
    const a = await seed();
    const cause =
      "Hard bounce rate of 6.4% across 12,004 messages sent between 8 and 10 August.";
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName, cause })),
      deps({ ses: a.ses }),
    );

    const response = await handleRelaySend(sendRequest(a.token), {
      db,
      ses: a.ses,
      allowance: unlimitedAllowance,
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(403);
    expect(body.reason).toContain(cause);
    // Not a generic error: the sentence a journey records has to be readable.
    expect(String(body.reason)).not.toBe("send failed");
  });
});

// ---------------------------------------------------------------------------
// EARS 9 — an unknown tenant must never wedge the pipeline
// ---------------------------------------------------------------------------

describe("unknown tenant", () => {
  it("records the event and does not throw", async () => {
    const id = eventBridgeId("orphan");
    const response = await handleSesAbuseEvent(
      abuseRequest(
        sendingStatusDisabled({ tenantName: "env-gone-for-good", id }),
      ),
      deps(),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("unknown_tenant");

    const rows = await db
      .select()
      .from(emailAbuseEvents)
      .where(eq(emailAbuseEvents.eventId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environmentId).toBeNull();
    expect(rows[0]?.tenantName).toBe("env-gone-for-good");
    expect(rows[0]?.outcome).toBe("unknown_tenant");
    expect(sent).toHaveLength(0);
  });

  it("a known tenant still processes after an unknown one", async () => {
    const a = await seed();
    await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: "env-nobody" })),
      deps(),
    );
    const response = await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ ses: a.ses }),
    );

    expect((await response.json()).action).toBe("paused");
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("paused");
  });

  it("an event naming no tenant at all is recorded, not thrown", async () => {
    const payload = sendingStatusDisabled({ tenantName: "env-x" });
    payload.resources = [];
    (payload.detail as Record<string, unknown>).reputationEntityReference =
      undefined;

    const response = await handleSesAbuseEvent(abuseRequest(payload), deps());
    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("unknown_tenant");
  });
});

// ---------------------------------------------------------------------------
// The ingress itself
// ---------------------------------------------------------------------------

describe("EventBridge ingress security", () => {
  it("refuses a request with no secret", async () => {
    const a = await seed();
    const request = new Request("http://localhost:3004/api/email/reputation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendingStatusDisabled({ tenantName: a.tenantName })),
    });

    const response = await handleSesAbuseEvent(request, deps());
    expect(response.status).toBe(403);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("active");
  });

  it("refuses a request with the wrong secret", async () => {
    const a = await seed();
    const response = await handleSesAbuseEvent(
      abuseRequest(
        sendingStatusDisabled({ tenantName: a.tenantName }),
        "not-the-secret",
      ),
      deps(),
    );
    expect(response.status).toBe(403);
  });

  it("fails CLOSED when no secret is configured", async () => {
    const a = await seed();
    const response = await handleSesAbuseEvent(
      abuseRequest(sendingStatusDisabled({ tenantName: a.tenantName })),
      deps({ secret: null }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("eventbridge_not_configured");
  });

  it("refuses a body that is not an EventBridge event", async () => {
    const response = await handleSesAbuseEvent(
      abuseRequest({ hello: "world" }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("ignores a detail-type it does not consume", async () => {
    const payload = sendingStatusDisabled({ tenantName: "env-x" });
    payload["detail-type"] = "Some Other SES Event";
    const response = await handleSesAbuseEvent(abuseRequest(payload), deps());
    // 200: asking EventBridge to redeliver something we deliberately drop
    // would be a retry that can never succeed.
    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("ignored");
  });

  it("refuses an event from a source that is not aws.ses", async () => {
    const a = await seed();
    const payload = sendingStatusDisabled({
      tenantName: a.tenantName,
      source: "aws.evil",
    });
    const response = await handleSesAbuseEvent(abuseRequest(payload), deps());
    expect(response.status).toBe(403);
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("active");
  });
});

describe("verifyEventBridgeSecret", () => {
  it("accepts the configured secret", () => {
    const headers = new Headers({ [EVENTBRIDGE_SECRET_HEADER]: "s3cret" });
    expect(() =>
      verifyEventBridgeSecret({ headers, secret: "s3cret" }),
    ).not.toThrow();
  });

  it("refuses a secret of a different length without throwing a range error", () => {
    const headers = new Headers({ [EVENTBRIDGE_SECRET_HEADER]: "short" });
    try {
      verifyEventBridgeSecret({ headers, secret: "a-much-longer-secret" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(EventBridgeVerificationError);
      expect((error as EventBridgeVerificationError).reason).toBe("mismatch");
    }
  });

  it("refuses when no secret is configured", () => {
    const headers = new Headers({ [EVENTBRIDGE_SECRET_HEADER]: "anything" });
    try {
      verifyEventBridgeSecret({ headers, secret: null });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as EventBridgeVerificationError).reason).toBe(
        "not_configured",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The human end of the appeals queue
// ---------------------------------------------------------------------------

describe("the operator lever", () => {
  it("suspends through the seam's own sending-status verb", async () => {
    const a = await seed();

    const result = await suspendEmailSending({
      environmentId: a.environmentId,
      cause: "Sending to a list purchased from a third party (AUP §2.2).",
      clause: "2.2",
      variant: "manual",
      actor: "operator@hogsend.com",
      db,
      ses: a.ses,
      sender,
    });

    expect(result.suspended).toBe(true);
    expect(a.ses.__tenant(a.tenantName)?.sendingStatus).toBe("DISABLED");
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    // `enforced`, not `paused`: OUR stop, and an appeal has to be able to tell
    // the two apart.
    expect(status.status).toBe("enforced");
    expect(sent[0]?.text).toContain("clause 2.2");
  });

  it("sends no appeal route for a clause that has none", async () => {
    const a = await seed();
    await suspendEmailSending({
      environmentId: a.environmentId,
      cause: "Messages impersonating a payment provider.",
      clause: "3.2",
      variant: "manual",
      actor: "operator@hogsend.com",
      db,
      ses: a.ses,
      sender,
    });

    // AUP §6.7 — phishing and malware end sending permanently, and the notice
    // must not invite a reply it would have to refuse.
    expect(sent[0]?.text).toContain("no appeal for");
    expect(sent[0]?.text).not.toContain("Reply to this email and tell us");
  });

  it("reinstating is a transition, tells the customer, and repeats nothing", async () => {
    const a = await seed();
    await suspendEmailSending({
      environmentId: a.environmentId,
      cause: "Hard bounce rate of 6.1%.",
      clause: "5.1",
      db,
      ses: a.ses,
      sender,
    });

    const first = await reinstateEmailSending({
      environmentId: a.environmentId,
      actor: "operator@hogsend.com",
      db,
      ses: a.ses,
      sender,
    });
    const second = await reinstateEmailSending({
      environmentId: a.environmentId,
      actor: "operator@hogsend.com",
      db,
      ses: a.ses,
      sender,
    });

    expect(first.reinstated).toBe(true);
    expect(first.notified).toBe(true);
    // Not a second pause event, so not a second email.
    expect(second.reinstated).toBe(false);
    expect(second.notified).toBe(false);

    expect(a.ses.__tenant(a.tenantName)?.sendingStatus).toBe("REINSTATED");
    const status = await readEmailSendingStatus({
      environmentId: a.environmentId,
      db,
    });
    expect(status.status).toBe("reinstated");
    // One suspension notice, one reinstatement notice, and nothing else.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toContain("Sending restored for");
    expect(sent[1]?.text).toContain("watched tier");
  });

  it("a suspension already in place does not re-notify", async () => {
    const a = await seed();
    const args = {
      environmentId: a.environmentId,
      cause: "Hard bounce rate of 6.1%.",
      clause: "5.1",
      db,
      ses: a.ses,
      sender,
    };
    await suspendEmailSending(args);
    const again = await suspendEmailSending(args);

    expect(again.suspended).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The relay's own pause repair still lands in history
// ---------------------------------------------------------------------------

describe("pause history", () => {
  it("records a pause the relay discovered at the wire", async () => {
    const a = await seed();
    await recordEmailSendingStatus({
      environmentId: a.environmentId,
      status: "paused",
      reason: "SES paused this tenant",
      source: "relay",
      db,
    });

    const rows = await db
      .select()
      .from(emailPauseHistory)
      .where(
        and(
          eq(emailPauseHistory.environmentId, a.environmentId),
          eq(emailPauseHistory.source, "relay"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("re-asserting the same status appends nothing", async () => {
    const a = await seed();
    for (let i = 0; i < 3; i += 1) {
      await recordEmailSendingStatus({
        environmentId: a.environmentId,
        status: "paused",
        reason: "SES paused this tenant",
        source: "relay",
        db,
      });
    }

    const rows = await db
      .select()
      .from(emailPauseHistory)
      .where(eq(emailPauseHistory.environmentId, a.environmentId));
    expect(rows).toHaveLength(1);
  });
});
