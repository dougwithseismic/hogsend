import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as sendRoute } from "@/app/api/email/send/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { emailIdempotency, environments, organizations } from "../db/schema";
import { env } from "../env";
import type {
  AllowanceCommit,
  AllowanceGate,
  AllowanceRequest,
} from "../lib/email-allowance";
import {
  EMAIL_RELAY_BURST_LIMIT,
  EMAIL_RELAY_WINDOW_MS,
  emailRelayBucket,
  handleRelaySend,
  MAX_SEND_REQUEST_BYTES,
} from "../lib/email-relay";
import { consumeRateLimit } from "../lib/rate-limit";
import {
  readEmailSendingStatus,
  recordEmailSendingStatus,
} from "../services/email-sending-status";
import { RelayTokenService } from "../services/relay-tokens";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, resetSesClients } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { SesError } from "../ses/types";

/**
 * `POST /api/email/send` — the reason AWS credentials never leave the control
 * plane.
 *
 * EVERY assertion about whether a message reached the wire is made against the
 * FAKE'S CALL LOG, never against the response body. That is not fussiness: an
 * idempotency bug produces two identical-looking 200s, and a response body
 * cannot tell you which of them cost a delivery. The counter can.
 *
 * No test here reaches AWS. The relay takes its `SesClient` as a dependency and
 * every case passes a `FakeSesClient`; the one case that does NOT (the route
 * wiring test) resolves the process-wide fake, because the suite runs with no
 * AWS credentials in the environment.
 */

const ORG = "email-relay-send-test-org";
const tokens = new RelayTokenService(db);

/** The sending domain every fixture's identity is verified for. */
const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

let seq = 0;

interface Fixture {
  environmentId: string;
  token: string;
  ses: FakeSesClient;
  tenantName: string;
}

/**
 * Put a fake into the state a fully provisioned environment is actually in.
 *
 * The Fake enforces the wire's own sender-side preconditions — a verified
 * identity, ASSOCIATED with the named tenant — so a send test that skipped this
 * would not be testing the relay, it would be watching the Fake refuse. Mirrors
 * `sendReadyFake()` in `ses-fake.test.ts` (PRD 02).
 */
async function makeSendReady(
  ses: FakeSesClient,
  tenantName: string,
): Promise<void> {
  await ses.createTenant({ tenantName });
  // One identity per fake, even when a fake serves two tenants: `createIdentity`
  // reports `already_exists`, exactly as AWS does.
  if (!ses.calls.some((call) => call.method === "createIdentity")) {
    await ses.createIdentity({ domain: DOMAIN });
    ses.__verifyIdentity(DOMAIN);
  }
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
}

async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `relay-send-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  const { token } = await tokens.mint({ environmentId: row.id });
  const ses = new FakeSesClient({ region: "us" });
  const tenantName = sesTenantName(row.id);
  await makeSendReady(ses, tenantName);
  return { environmentId: row.id, token, ses, tenantName };
}

/** The engine's mailer sends already-rendered HTML and nothing else. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    from: "Acme <hello@acme.test>",
    to: ["person@example.test"],
    subject: "Your weekly digest",
    html: "<p>Hello</p>",
    ...overrides,
  };
}

function sendRequest(options: {
  token?: string;
  idempotencyKey?: string | null;
  body?: unknown;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey !== null) {
    headers["idempotency-key"] = options.idempotencyKey ?? "idem-default";
  }
  return new Request("http://localhost:3004/api/email/send", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? { message: message() }),
  });
}

/** How many times the wire was actually touched. The only honest counter. */
function sendCalls(ses: FakeSesClient): number {
  return ses.calls.filter((call) => call.method === "sendEmail").length;
}

async function idempotencyRows(environmentId: string) {
  return db
    .select()
    .from(emailIdempotency)
    .where(eq(emailIdempotency.environmentId, environmentId));
}

/**
 * Fill an environment's burst window, and hand back the instant it was filled
 * at.
 *
 * The window is wall-clock fixed, so a test that pre-filled at :59.9 and then
 * sent at :00.1 would land in a FRESH window and be allowed. Pinning one `now`
 * across both halves is what makes the refusal a fact rather than a coin flip.
 */
async function fillBurstWindow(
  environmentId: string,
  used: number = EMAIL_RELAY_BURST_LIMIT,
): Promise<Date> {
  const now = new Date();
  await consumeRateLimit({
    bucket: emailRelayBucket(environmentId),
    limit: EMAIL_RELAY_BURST_LIMIT,
    windowMs: EMAIL_RELAY_WINDOW_MS,
    cost: used,
    now,
  });
  return now;
}

/** An allowance gate that records every question it was asked. */
function recordingAllowance(
  verdict: "allow" | "refuse" = "allow",
): AllowanceGate & {
  asked: AllowanceRequest[];
  metered: AllowanceCommit[];
} {
  const asked: AllowanceRequest[] = [];
  // What the relay said it SENT. PRD 09 counts here, so a gate that is asked
  // and never told (or told without being asked) is visible to these tests.
  const metered: AllowanceCommit[] = [];
  return {
    asked,
    metered,
    async recordSent(commit) {
      metered.push(commit);
    },
    async canSend(request) {
      asked.push(request);
      return verdict === "allow"
        ? { allowed: true }
        : {
            allowed: false,
            reason: "allowance_exhausted",
            limit: 1000,
            used: 1000,
          };
    },
  };
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Email Relay Send Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

describe("POST /api/email/send — authentication (EARS 1)", () => {
  it("refuses a request with no token and never calls SES", async () => {
    const fixture = await seed();
    const response = await handleRelaySend(
      sendRequest({ idempotencyKey: "auth-none" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "missing_token" });
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("refuses a token that is not one of ours", async () => {
    const fixture = await seed();
    const response = await handleRelaySend(
      sendRequest({ token: "hsrel_nope", idempotencyKey: "auth-bad" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("refuses a rotated-away token", async () => {
    const fixture = await seed();
    await tokens.rotate({ environmentId: fixture.environmentId });

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "auth-rotated" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(401);
    expect(sendCalls(fixture.ses)).toBe(0);
  });
});

describe("POST /api/email/send — the tenant is the TOKEN's (EARS 4)", () => {
  it("sends under the token's tenant and configuration set", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "tenant-happy" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "fake-ses-message-1" });

    const sent = fixture.ses.__sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tenantName).toBe(fixture.tenantName);
    expect(sent[0]?.configurationSetName).toBe(
      sesConfigurationSetName(fixture.environmentId),
    );
    expect(sent[0]?.message.subject).toBe("Your weekly digest");
  });

  it("REJECTS a body that tries to name its own SES tenant", async () => {
    const a = await seed();
    const b = await seed();
    await makeSendReady(a.ses, b.tenantName);

    // If a request body could choose the tenant, tenant isolation would be
    // advisory: one customer could send — and burn reputation — as another.
    for (const body of [
      { message: message(), tenantName: b.tenantName },
      { message: message(), tenant: b.tenantName },
      { message: message(), configurationSetName: "somebody-elses" },
      { message: { ...message(), tenantName: b.tenantName } },
    ]) {
      const response = await handleRelaySend(
        sendRequest({
          token: a.token,
          idempotencyKey: `tenant-spoof-${JSON.stringify(body).length}`,
          body,
        }),
        { ses: a.ses },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(sendCalls(a.ses)).toBe(0);
  });

  it("rejects a payload carrying React or a template reference (HTML only)", async () => {
    const fixture = await seed();

    for (const body of [
      { message: { ...message(), react: { type: "div" } } },
      { message: { ...message(), template: "welcome" } },
      { message: { ...message(), html: undefined } },
    ]) {
      const response = await handleRelaySend(
        sendRequest({
          token: fixture.token,
          idempotencyKey: `html-only-${JSON.stringify(body).length}`,
          body,
        }),
        { ses: fixture.ses },
      );
      expect(response.status).toBe(400);
    }
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("REJECTS a message whose combined to+cc+bcc exceeds the recipient cap", async () => {
    const fixture = await seed();

    // Each field is at (or under) the 50-cap on its own, but SES caps the
    // COMBINED destination count: to:[50] + cc:[1] is 51 at the wire. Refuse it
    // up front rather than let SES return a 400 send_rejected.
    const to = Array.from({ length: 50 }, (_, i) => `to-${i}@example.test`);
    const cc = ["cc-0@example.test"];
    const response = await handleRelaySend(
      sendRequest({
        token: fixture.token,
        idempotencyKey: "combined-recipient-cap",
        body: { message: message({ to, cc }) },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(sendCalls(fixture.ses)).toBe(0);
  });
});

describe("POST /api/email/send — idempotency (EARS 3)", () => {
  it("calls SES EXACTLY ONCE for a repeated idempotency key", async () => {
    const fixture = await seed();

    const first = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "idem-repeat" }),
      { ses: fixture.ses },
    );
    const second = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "idem-repeat" }),
      { ses: fixture.ses },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { id: string };
    expect(await second.json()).toMatchObject({ id: firstBody.id });

    // The assertion that matters: two identical-looking 200s, ONE delivery.
    expect(sendCalls(fixture.ses)).toBe(1);
    expect(fixture.ses.__sent()).toHaveLength(1);
  });

  it("calls SES exactly once when two identical sends race", async () => {
    const fixture = await seed();

    const [a, b] = await Promise.all([
      handleRelaySend(
        sendRequest({ token: fixture.token, idempotencyKey: "idem-race" }),
        { ses: fixture.ses },
      ),
      handleRelaySend(
        sendRequest({ token: fixture.token, idempotencyKey: "idem-race" }),
        { ses: fixture.ses },
      ),
    ]);

    // The unique index decides which one wins; the loser is either told the id
    // (if the winner already finished) or that a send is in flight.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    expect(sendCalls(fixture.ses)).toBe(1);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(1);
  });

  it("treats different keys as different messages", async () => {
    const fixture = await seed();

    await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "idem-a" }),
      { ses: fixture.ses },
    );
    await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "idem-b" }),
      { ses: fixture.ses },
    );

    expect(sendCalls(fixture.ses)).toBe(2);
  });

  it("scopes keys to the environment — one tenant cannot replay another's", async () => {
    const a = await seed();
    const b = await seed();
    await makeSendReady(a.ses, b.tenantName);

    await handleRelaySend(
      sendRequest({ token: a.token, idempotencyKey: "shared-key" }),
      { ses: a.ses },
    );
    const second = await handleRelaySend(
      sendRequest({ token: b.token, idempotencyKey: "shared-key" }),
      { ses: a.ses },
    );

    expect(second.status).toBe(200);
    expect(sendCalls(a.ses)).toBe(2);
    expect(a.ses.__sent()[1]?.tenantName).toBe(b.tenantName);
  });

  it("caps the body against a request that LIED about its length", async () => {
    const fixture = await seed();
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Generated lazily so proving the meter works does not cost the suite
        // the cap's worth of resident memory. Bounded BY the cap constant, not
        // a literal: a stream that stopped under a raised cap would reach the
        // JSON parser and this test would quietly stop testing the meter.
        if (sent > MAX_SEND_REQUEST_BYTES) {
          controller.close();
          return;
        }
        sent += megabyte.byteLength;
        controller.enqueue(megabyte);
      },
    });

    const response = await handleRelaySend(
      new Request("http://localhost:3004/api/email/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${fixture.token}`,
          "idempotency-key": "oversize",
          // The lie. A cap that trusted this would be no cap at all.
          "content-length": "512",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
    expect(sendCalls(fixture.ses)).toBe(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  }, 60_000);

  it("requires an idempotency key", async () => {
    const fixture = await seed();
    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: null }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "missing_idempotency_key",
    });
    expect(sendCalls(fixture.ses)).toBe(0);
  });
});

describe("POST /api/email/send — failures (EARS 5, 6)", () => {
  it("leaves NO idempotency row after a transient failure, so a retry sends", async () => {
    const fixture = await seed();
    fixture.ses.failNext("sendEmail");

    const failed = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "transient" }),
      { ses: fixture.ses },
    );

    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBeTruthy();
    // A row left behind here would make the retry below answer 200 for a
    // message that never existed.
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);

    const retried = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "transient" }),
      { ses: fixture.ses },
    );
    expect(retried.status).toBe(200);
    expect(fixture.ses.__sent()).toHaveLength(1);
  });

  it("leaves no row after a permanent rejection", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient("person@example.test");

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "rejected" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "send_rejected" });
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });

  it("persists the paused state SES reports, so the next request never dials", async () => {
    const fixture = await seed();
    fixture.ses.__pauseTenant(fixture.tenantName, "reputation: hard bounces");

    const first = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "ses-paused" }),
      { ses: fixture.ses },
    );

    expect(first.status).toBe(403);
    expect(await first.json()).toMatchObject({ error: "tenant_paused" });
    const mirrored = await readEmailSendingStatus({
      environmentId: fixture.environmentId,
    });
    expect(mirrored.status).toBe("paused");
    expect(mirrored.pausedAt).not.toBeNull();
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);

    const callsAfterFirst = fixture.ses.calls.length;
    const second = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "ses-paused-2" }),
      { ses: fixture.ses },
    );
    expect(second.status).toBe(403);
    // The whole point of persisting it: no network call the second time.
    expect(fixture.ses.calls).toHaveLength(callsAfterFirst);
  });

  it("answers 503 rather than a paused status when SES is throttling", async () => {
    const fixture = await seed();
    fixture.ses.failNext(
      "sendEmail",
      new SesError("slow down", { kind: "throttled" }),
    );

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "throttled" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(503);
    // A throttle must not be mistaken for a pause: the mirror stays clean.
    expect(
      (await readEmailSendingStatus({ environmentId: fixture.environmentId }))
        .status,
    ).toBe("active");
  });
});

describe("POST /api/email/send — a paused tenant fails closed (EARS 2)", () => {
  it("refuses with the recorded reason and NEVER reaches SES", async () => {
    const fixture = await seed();
    const pausedAt = new Date("2026-08-10T09:00:00.000Z");
    await recordEmailSendingStatus({
      environmentId: fixture.environmentId,
      status: "paused",
      reason: "AWS reputation policy: complaint rate",
      at: pausedAt,
    });

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "paused-closed" }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "tenant_paused",
      message: expect.any(String),
      reason: "AWS reputation policy: complaint rate",
      pausedAt: pausedAt.toISOString(),
    });
    // Not "no send" — NO CALL AT ALL. A paused tenant costs no round trip.
    expect(sendCalls(fixture.ses)).toBe(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });

  it("refuses an operator enforcement the same way", async () => {
    const fixture = await seed();
    await recordEmailSendingStatus({
      environmentId: fixture.environmentId,
      status: "enforced",
      reason: "abuse review",
    });

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "enforced" }),
      { ses: fixture.ses },
    );
    expect(response.status).toBe(403);
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("lets a REINSTATED tenant send", async () => {
    const fixture = await seed();
    await recordEmailSendingStatus({
      environmentId: fixture.environmentId,
      status: "reinstated",
      reason: "appeal accepted",
    });

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "reinstated" }),
      { ses: fixture.ses },
    );
    expect(response.status).toBe(200);
    expect(sendCalls(fixture.ses)).toBe(1);
  });
});

describe("POST /api/email/send — burst limit (EARS 9)", () => {
  it("returns 429 with Retry-After, consuming no allowance and no wire", async () => {
    const fixture = await seed();
    const allowance = recordingAllowance();

    // Fill this environment's real window in one statement rather than by
    // sending EMAIL_RELAY_BURST_LIMIT messages.
    const now = await fillBurstWindow(fixture.environmentId);

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "throttle-me" }),
      { ses: fixture.ses, allowance, now },
    );

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
    expect(sendCalls(fixture.ses)).toBe(0);
    // "Consumes no allowance" means the gate was never even ASKED — and, since
    // PRD 09, that nothing was metered against the month either.
    expect(allowance.asked).toHaveLength(0);
    expect(allowance.metered).toHaveLength(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });

  it("throttles BEFORE it inspects anything the caller controls", async () => {
    const fixture = await seed();
    const now = await fillBurstWindow(fixture.environmentId);

    // No idempotency key and an unparseable body — both 400s if validation ran
    // first. A caller who could dodge the limiter by sending garbage would have
    // no limiter at all.
    for (const request of [
      sendRequest({ token: fixture.token, idempotencyKey: null }),
      sendRequest({ token: fixture.token, body: { message: { nope: true } } }),
    ]) {
      const response = await handleRelaySend(request, {
        ses: fixture.ses,
        now,
      });
      expect(response.status).toBe(429);
    }
    expect(sendCalls(fixture.ses)).toBe(0);
  });

  it("keeps one environment's burst budget out of another's", async () => {
    const a = await seed();
    const b = await seed();
    await makeSendReady(a.ses, b.tenantName);

    const now = await fillBurstWindow(a.environmentId);

    const response = await handleRelaySend(
      sendRequest({ token: b.token, idempotencyKey: "neighbour" }),
      { ses: a.ses, now },
    );
    expect(response.status).toBe(200);
  });
});

describe("POST /api/email/send — the allowance seam", () => {
  it("asks the gate once, for this environment and one message", async () => {
    const fixture = await seed();
    const allowance = recordingAllowance();

    await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "allowance-ok" }),
      { ses: fixture.ses, allowance },
    );

    expect(allowance.asked).toEqual([
      {
        environmentId: fixture.environmentId,
        organizationId: ORG,
        count: 1,
      },
    ]);
  });

  it("refuses with 402 and touches neither the wire nor the store", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "allowance-no" }),
      { ses: fixture.ses, allowance: recordingAllowance("refuse") },
    );

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: "allowance_exhausted",
      limit: 1000,
      used: 1000,
    });
    expect(sendCalls(fixture.ses)).toBe(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });
});

describe("POST /api/email/send — the route as Next runs it", () => {
  it("wires the handler to the process-wide SES client", async () => {
    const fixture = await seed();
    // No AWS credentials in the test environment, so this IS the fake.
    const ses = getFakeSesClient("us");
    await makeSendReady(ses, fixture.tenantName);
    const before = ses.__sent().length;

    const response = await sendRoute(
      sendRequest({ token: fixture.token, idempotencyKey: "route-wiring" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: expect.any(String) });
    const sent = ses.__sent();
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)?.tenantName).toBe(fixture.tenantName);
  });
});

describe("email idempotency claims", () => {
  it("takes over a claim abandoned by a killed process", async () => {
    const fixture = await seed();
    const { claimIdempotencyKey } = await import(
      "../services/email-idempotency"
    );

    // A process that claimed and then died: a row with no message id.
    const orphan = await claimIdempotencyKey({
      environmentId: fixture.environmentId,
      idempotencyKey: "abandoned",
      now: new Date(Date.now() - 10 * 60_000),
    });
    expect(orphan.outcome).toBe("claimed");

    // A live contender is told to wait...
    const blocked = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "abandoned" }),
      {
        ses: fixture.ses,
        now: new Date(Date.now() - 10 * 60_000 + 1_000),
      },
    );
    expect(blocked.status).toBe(409);
    expect(sendCalls(fixture.ses)).toBe(0);

    // ...and past the takeover window, the dead claim stops poisoning the key.
    const taken = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "abandoned" }),
      { ses: fixture.ses },
    );
    expect(taken.status).toBe(200);
    expect(sendCalls(fixture.ses)).toBe(1);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(1);
  });

  it("a late release of a STOLEN claim leaves the thief's live claim intact", async () => {
    const fixture = await seed();
    const {
      claimIdempotencyKey,
      commitIdempotencyClaim,
      releaseIdempotencyClaim,
    } = await import("../services/email-idempotency");
    const claim = { environmentId: fixture.environmentId };

    // A claims, then its SES call outlives the takeover window (a hung
    // socket, a throttled 50-item batch) without dying.
    const t0 = new Date(Date.now() - 5 * 60_000);
    const slow = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "stolen",
      now: t0,
    });
    if (slow.outcome !== "claimed") throw new Error("expected a claim");

    // B takes the stale claim over — SAME row, new ownership — and is at the
    // wire right now.
    const thief = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "stolen",
      now: new Date(t0.getTime() + 61_000),
    });
    if (thief.outcome !== "claimed") throw new Error("expected a takeover");
    expect(thief.rowId).toBe(slow.rowId);

    // A's hung send finally fails and A releases LATE. The row is not A's
    // claim any more, so this must be a no-op — deleting it would reopen the
    // key while B's send is in flight.
    await releaseIdempotencyClaim({
      rowId: slow.rowId,
      claimedAt: slow.claimedAt,
    });

    // A third contender is still told the key is in flight...
    const third = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "stolen",
      now: new Date(t0.getTime() + 62_000),
    });
    expect(third.outcome).toBe("in_flight");

    // ...and the send SES accepted from B still has its row to be recorded on.
    await commitIdempotencyClaim({ rowId: thief.rowId, messageId: "m-thief" });
    const replay = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "stolen",
      now: new Date(t0.getTime() + 63_000),
    });
    expect(replay).toEqual({ outcome: "replay", messageId: "m-thief" });
  });

  it("the FIRST commit wins; a late duplicate commit cannot overwrite it", async () => {
    const fixture = await seed();
    const { claimIdempotencyKey, commitIdempotencyClaim } = await import(
      "../services/email-idempotency"
    );
    const claim = { environmentId: fixture.environmentId };

    const t0 = new Date(Date.now() - 5 * 60_000);
    const slow = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "first-commit",
      now: t0,
    });
    if (slow.outcome !== "claimed") throw new Error("expected a claim");
    const thief = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "first-commit",
      now: new Date(t0.getTime() + 61_000),
    });
    if (thief.outcome !== "claimed") throw new Error("expected a takeover");

    // Both reached SES — the takeover's documented price. Whichever commits
    // first is the replayable answer, for good.
    await commitIdempotencyClaim({ rowId: thief.rowId, messageId: "m-first" });
    await commitIdempotencyClaim({ rowId: slow.rowId, messageId: "m-late" });

    const replay = await claimIdempotencyKey({
      ...claim,
      idempotencyKey: "first-commit",
      now: new Date(t0.getTime() + 62_000),
    });
    expect(replay).toEqual({ outcome: "replay", messageId: "m-first" });
  });

  it("retires rows past the retention window and keeps the rest", async () => {
    const fixture = await seed();
    const { sweepEmailIdempotency, EMAIL_IDEMPOTENCY_RETENTION_MS } =
      await import("../services/email-idempotency");

    const now = new Date();
    await db.insert(emailIdempotency).values([
      {
        environmentId: fixture.environmentId,
        idempotencyKey: "old",
        messageId: "m-old",
        createdAt: new Date(now.getTime() - EMAIL_IDEMPOTENCY_RETENTION_MS - 1),
        claimedAt: new Date(now.getTime() - EMAIL_IDEMPOTENCY_RETENTION_MS - 1),
      },
      {
        environmentId: fixture.environmentId,
        idempotencyKey: "fresh",
        messageId: "m-fresh",
        createdAt: now,
        claimedAt: now,
      },
    ]);

    const removed = await sweepEmailIdempotency({
      environmentId: fixture.environmentId,
      now,
    });

    expect(removed).toBe(1);
    const remaining = await db
      .select({ key: emailIdempotency.idempotencyKey })
      .from(emailIdempotency)
      .where(
        and(
          eq(emailIdempotency.environmentId, fixture.environmentId),
          eq(emailIdempotency.idempotencyKey, "fresh"),
        ),
      );
    expect(remaining).toHaveLength(1);
  });
});

describe("POST /api/email/send — a post-send DB blip never re-sends", () => {
  /**
   * A `db` that lets everything through EXCEPT the claim commit, which rejects
   * as a transient DB error would. ONLY the `emailIdempotency` UPDATE is failed,
   * so the rate-limit charge, tier cap, allowance and the claim INSERT all run
   * for real — the failure lands exactly where SES has already accepted the
   * message, which is the double-send window.
   */
  function commitFailingDb(): typeof db {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "update") {
          return (table: unknown) => {
            if (table === emailIdempotency) {
              return {
                set: () => ({
                  where: () =>
                    Promise.reject(new Error("transient db commit blip")),
                }),
              };
            }
            return (target.update as (t: unknown) => unknown)(table);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof db;
  }

  it("keeps the claim and never re-sends when the post-send commit fails", async () => {
    const fixture = await seed();

    const response = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "commit-blip" }),
      { ses: fixture.ses, db: commitFailingDb() },
    );

    // SES accepted, so the caller gets the id and a NON-retryable 200. Before
    // the fix the commit ran inside the SES try: its failure released the claim
    // and returned 502 send_failed, which `retryable()` marks retryable — the
    // durable layer re-sent and the recipient got it twice.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: expect.any(String) });
    expect(sendCalls(fixture.ses)).toBe(1);

    // The claim was NOT deleted, so a retry finds it in flight rather than a
    // clean key, and never dials SES again.
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(1);

    const retry = await handleRelaySend(
      sendRequest({ token: fixture.token, idempotencyKey: "commit-blip" }),
      { ses: fixture.ses },
    );
    expect([200, 409]).toContain(retry.status);
    expect(sendCalls(fixture.ses)).toBe(1);
  });
});
