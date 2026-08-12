import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as batchRoute } from "@/app/api/email/send-batch/route";
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
  handleRelaySendBatch,
  MAX_BATCH_ITEMS,
  type RelayBatchResult,
} from "../lib/email-relay";
import { consumeRateLimit } from "../lib/rate-limit";
import { recordEmailSendingStatus } from "../services/email-sending-status";
import { RelayTokenService } from "../services/relay-tokens";
import type { FakeSesCall } from "../ses/fake";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, resetSesClients } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import type { SesSendBatchInput } from "../ses/types";

/**
 * `POST /api/email/send-batch`.
 *
 * The decision this file exists to defend is that **batch idempotency is PER
 * ITEM**. One key for the whole request would make a partially failed batch
 * un-retryable: the retry would match the request-level key, return the
 * original response, and the items that failed would never be sent — silently,
 * with a 200 in front of it. So the assertions below are about WHICH messages
 * reached the wire on the retry, read off the Fake's call log, not about what
 * the response said.
 */

const ORG = "email-relay-batch-test-org";
const tokens = new RelayTokenService(db);

const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;
/** The one address the Fake refuses, so a partial failure is reproducible. */
const BAD_RECIPIENT = "bounces@example.test";

let seq = 0;

interface Fixture {
  environmentId: string;
  token: string;
  ses: FakeSesClient;
  tenantName: string;
}

/** The state a fully provisioned environment is in — see the send suite. */
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

async function seed(): Promise<Fixture> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `relay-batch-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  const { token } = await tokens.mint({ environmentId: row.id });
  const ses = new FakeSesClient({ region: "us" });
  const tenantName = sesTenantName(row.id);
  await makeSendReady(ses, tenantName);
  return { environmentId: row.id, token, ses, tenantName };
}

function item(key: string, to: string) {
  return {
    idempotencyKey: key,
    message: {
      from: "Acme <hello@acme.test>",
      to: [to],
      subject: `Message for ${to}`,
      html: "<p>Hello</p>",
    },
  };
}

function batchRequest(options: { token?: string; body?: unknown }): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request("http://localhost:3004/api/email/send-batch", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
}

async function results(response: Response): Promise<RelayBatchResult[]> {
  return ((await response.json()) as { results: RelayBatchResult[] }).results;
}

function batchCalls(ses: FakeSesClient): FakeSesCall[] {
  return ses.calls.filter((call) => call.method === "sendBatch");
}

/** The recipients of every message one `sendBatch` call carried, in order. */
function recipientsOf(call: FakeSesCall): string[] {
  const input = call.args[0] as SesSendBatchInput;
  return input.messages.flatMap((message) => message.to);
}

async function idempotencyRows(environmentId: string) {
  return db
    .select()
    .from(emailIdempotency)
    .where(eq(emailIdempotency.environmentId, environmentId));
}

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
            limit: 500,
            used: 500,
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
    .values({ id: ORG, name: "Email Relay Batch Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

describe("POST /api/email/send-batch — positional results (EARS 7)", () => {
  it("returns one result per input item, in input order", async () => {
    const fixture = await seed();
    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("pos-1", "one@example.test"),
            item("pos-2", "two@example.test"),
            item("pos-3", "three@example.test"),
          ],
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(200);
    expect(await results(response)).toEqual([
      { status: "sent", id: "fake-ses-message-1" },
      { status: "sent", id: "fake-ses-message-2" },
      { status: "sent", id: "fake-ses-message-3" },
    ]);
    expect(fixture.ses.__sent().map((sent) => sent.message.to[0])).toEqual([
      "one@example.test",
      "two@example.test",
      "three@example.test",
    ]);
  });

  it("sends every message under the TOKEN's tenant and configuration set", async () => {
    const fixture = await seed();
    await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("tenant-1", "one@example.test")] },
      }),
      { ses: fixture.ses },
    );

    const call = batchCalls(fixture.ses)[0];
    if (!call) throw new Error("no sendBatch call");
    const input = call.args[0] as SesSendBatchInput;
    expect(input.tenantName).toBe(fixture.tenantName);
    expect(input.configurationSetName).toBe(
      sesConfigurationSetName(fixture.environmentId),
    );
  });

  it("rejects a body naming its own tenant, or carrying React", async () => {
    const fixture = await seed();

    for (const body of [
      { items: [item("x", "one@example.test")], tenantName: "somebody-else" },
      {
        items: [
          { ...item("x", "one@example.test"), tenantName: "somebody-else" },
        ],
      },
      {
        items: [
          {
            idempotencyKey: "x",
            message: {
              from: "Acme <hello@acme.test>",
              to: ["one@example.test"],
              subject: "s",
              react: { type: "div" },
            },
          },
        ],
      },
    ]) {
      const response = await handleRelaySendBatch(
        batchRequest({ token: fixture.token, body }),
        { ses: fixture.ses },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(batchCalls(fixture.ses)).toHaveLength(0);
  });

  it("refuses two items sharing one idempotency key", async () => {
    const fixture = await seed();
    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("same", "one@example.test"),
            item("same", "two@example.test"),
          ],
        },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "duplicate_idempotency_key",
    });
    expect(batchCalls(fixture.ses)).toHaveLength(0);
  });

  it("refuses an empty batch and one past the cap", async () => {
    const fixture = await seed();

    const empty = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body: { items: [] } }),
      { ses: fixture.ses },
    );
    expect(empty.status).toBe(400);

    const tooMany = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, index) =>
            item(`cap-${index}`, `person${index}@example.test`),
          ),
        },
      }),
      { ses: fixture.ses },
    );
    expect(tooMany.status).toBe(400);
    expect(batchCalls(fixture.ses)).toHaveLength(0);
  });
});

describe("POST /api/email/send-batch — partial failure (EARS 7, 8)", () => {
  it("tolerates a failed item without failing the batch", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("partial-ok", "one@example.test"),
            item("partial-bad", BAD_RECIPIENT),
            item("partial-ok-2", "three@example.test"),
          ],
        },
      }),
      { ses: fixture.ses },
    );

    // 200: a batch is not all-or-nothing. One unroutable address must not cost
    // the other two their delivery.
    expect(response.status).toBe(200);
    const outcomes = await results(response);
    expect(outcomes[0]).toMatchObject({ status: "sent" });
    expect(outcomes[1]).toMatchObject({
      status: "failed",
      error: "send_rejected",
    });
    expect(outcomes[2]).toMatchObject({ status: "sent" });

    // The failed item left NO idempotency row, which is what makes the retry
    // below able to re-attempt it.
    const rows = await idempotencyRows(fixture.environmentId);
    expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([
      "partial-ok",
      "partial-ok-2",
    ]);
  });

  it("RE-ATTEMPTS ONLY THE FAILED ITEMS on a retry", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const body = {
      items: [
        item("retry-ok", "one@example.test"),
        item("retry-bad", BAD_RECIPIENT),
      ],
    };

    const first = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: fixture.ses },
    );
    const firstOutcomes = await results(first);
    expect(firstOutcomes[0]).toMatchObject({ status: "sent" });
    expect(firstOutcomes[1]).toMatchObject({ status: "failed" });

    // A second, healthy wire — the condition that rejected the address has
    // cleared, exactly as a transient SES-side problem would.
    const healthy = new FakeSesClient({ region: "us" });
    await makeSendReady(healthy, fixture.tenantName);

    const second = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: healthy },
    );

    expect(second.status).toBe(200);
    const secondOutcomes = await results(second);
    // The already-sent item is replayed from the store, with its ORIGINAL id
    // and no second delivery.
    expect(secondOutcomes[0]).toEqual({
      status: "sent",
      id: (firstOutcomes[0] as { id: string }).id,
      idempotent: true,
    });
    expect(secondOutcomes[1]).toMatchObject({ status: "sent" });

    // THE ASSERTION THIS TEST EXISTS FOR: exactly one message crossed the wire
    // on the retry, and it was the one that had failed.
    const retryCalls = batchCalls(healthy);
    expect(retryCalls).toHaveLength(1);
    if (!retryCalls[0]) throw new Error("no retry call");
    expect(recipientsOf(retryCalls[0])).toEqual([BAD_RECIPIENT]);
    expect(healthy.__sent()).toHaveLength(1);
  });

  it("does not touch the wire AT ALL when every item is a replay", async () => {
    const fixture = await seed();
    const body = {
      items: [
        item("replay-1", "one@example.test"),
        item("replay-2", "two@example.test"),
      ],
    };

    const first = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: fixture.ses },
    );
    const firstOutcomes = await results(first);

    const healthy = new FakeSesClient({ region: "us" });
    await makeSendReady(healthy, fixture.tenantName);
    const second = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: healthy },
    );

    expect(await results(second)).toEqual(
      firstOutcomes.map((outcome) => ({ ...outcome, idempotent: true })),
    );
    expect(batchCalls(healthy)).toHaveLength(0);
    expect(healthy.__sent()).toHaveLength(0);
  });
});

describe("POST /api/email/send-batch — whole-request outcomes", () => {
  it("answers 503 and leaves no rows when EVERY message failed transiently", async () => {
    const fixture = await seed();
    // The AWS client fans out one `SendEmail` per message and catches per
    // entry, so a wire outage arrives as every ENTRY failing rather than as a
    // throw. The Fake models that, which is why this is the realistic shape.
    fixture.ses.failNext("sendBatch");

    const body = {
      items: [
        item("batch-transient-1", "one@example.test"),
        item("batch-transient-2", "two@example.test"),
      ],
    };
    const failed = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: fixture.ses },
    );

    // Nothing got through, so this is not the partial failure a 200 describes.
    expect(failed.status).toBe(503);
    expect(Number(failed.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);

    // And so the caller's retry genuinely sends both.
    const retried = await handleRelaySendBatch(
      batchRequest({ token: fixture.token, body }),
      { ses: fixture.ses },
    );
    expect(retried.status).toBe(200);
    expect(fixture.ses.__sent()).toHaveLength(2);
  });

  it("still answers 200 when SOME messages got through", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("mixed-ok", "one@example.test"),
            item("mixed-bad", BAD_RECIPIENT),
          ],
        },
      }),
      { ses: fixture.ses },
    );

    // EARS 7: a partial failure must not fail the whole batch.
    expect(response.status).toBe(200);
    expect(fixture.ses.__sent()).toHaveLength(1);
  });

  it("answers 200 when every failure is PERMANENT, so nothing is retried", async () => {
    const fixture = await seed();
    fixture.ses.__rejectRecipient(BAD_RECIPIENT);

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("all-bad", BAD_RECIPIENT)] },
      }),
      { ses: fixture.ses },
    );

    // A 503 here would invite an infinite retry of a message SES will refuse
    // every time. Nothing got through, but nothing is going to.
    expect(response.status).toBe(200);
    expect(await results(response)).toEqual([
      { status: "failed", error: "send_rejected", message: expect.any(String) },
    ]);
  });

  it("fails closed with 403 when the whole batch came back paused", async () => {
    const fixture = await seed();
    fixture.ses.__pauseTenant(fixture.tenantName, "reputation: complaints");

    const first = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("batch-paused", "one@example.test")] },
      }),
      { ses: fixture.ses },
    );

    // Identical to what `send` answers, rather than a 403 hidden inside a 200.
    expect(first.status).toBe(403);
    expect(await first.json()).toMatchObject({
      error: "tenant_paused",
      reason: expect.stringContaining("SES paused this tenant"),
      pausedAt: expect.any(String),
    });

    // The mirror is repaired, so the NEXT request never dials at all.
    const callsBefore = fixture.ses.calls.length;
    const second = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("batch-paused-2", "one@example.test")] },
      }),
      { ses: fixture.ses },
    );
    expect(second.status).toBe(403);
    expect(fixture.ses.calls).toHaveLength(callsBefore);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });

  it("releases every claim if a provider throws the whole call", async () => {
    const fixture = await seed();
    // No implementation on the seam throws wholesale today — the AWS client
    // cannot — so the defensive branch is covered with a stub rather than left
    // as a plausible-looking path nobody has ever run.
    let calls = 0;
    const throwing = {
      ...fixture.ses,
      sendBatch: async () => {
        calls += 1;
        throw new Error("socket hang up");
      },
    } as unknown as FakeSesClient;

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("thrown-1", "one@example.test"),
            item("thrown-2", "two@example.test"),
          ],
        },
      }),
      { ses: throwing },
    );

    expect(calls).toBe(1);
    expect(response.status).toBe(502);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });
});

describe("POST /api/email/send-batch — gates", () => {
  it("refuses a paused environment before the wire", async () => {
    const fixture = await seed();
    await recordEmailSendingStatus({
      environmentId: fixture.environmentId,
      status: "paused",
      reason: "abuse review",
    });

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("gate-paused", "one@example.test")] },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(403);
    expect(batchCalls(fixture.ses)).toHaveLength(0);
  });

  it("refuses without a token", async () => {
    const fixture = await seed();
    const response = await handleRelaySendBatch(
      batchRequest({
        body: { items: [item("gate-anon", "one@example.test")] },
      }),
      { ses: fixture.ses },
    );

    expect(response.status).toBe(401);
    expect(batchCalls(fixture.ses)).toHaveLength(0);
  });

  it("charges the burst limit PER MESSAGE, not per request", async () => {
    const fixture = await seed();
    const allowance = recordingAllowance();

    // Leave room for exactly two more messages in this environment's window.
    // `now` is pinned across the fill and the request because the window is
    // wall-clock fixed: crossing a minute boundary between them would open a
    // fresh window and turn this assertion into a coin flip.
    const now = new Date();
    await consumeRateLimit({
      bucket: emailRelayBucket(fixture.environmentId),
      limit: EMAIL_RELAY_BURST_LIMIT,
      windowMs: EMAIL_RELAY_WINDOW_MS,
      cost: EMAIL_RELAY_BURST_LIMIT - 2,
      now,
    });

    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("burst-1", "one@example.test"),
            item("burst-2", "two@example.test"),
            item("burst-3", "three@example.test"),
          ],
        },
      }),
      { ses: fixture.ses, allowance, now },
    );

    // Three messages against two units of headroom. If a batch cost ONE unit,
    // batching would be a way to buy fifty times the burst budget.
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(batchCalls(fixture.ses)).toHaveLength(0);
    expect(allowance.asked).toHaveLength(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });

  it("asks the allowance gate for the whole batch at once", async () => {
    const fixture = await seed();
    const allowance = recordingAllowance();

    await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: {
          items: [
            item("allow-1", "one@example.test"),
            item("allow-2", "two@example.test"),
          ],
        },
      }),
      { ses: fixture.ses, allowance },
    );

    expect(allowance.asked).toEqual([
      { environmentId: fixture.environmentId, organizationId: ORG, count: 2 },
    ]);
  });

  it("refuses an exhausted allowance with 402, sending nothing", async () => {
    const fixture = await seed();
    const response = await handleRelaySendBatch(
      batchRequest({
        token: fixture.token,
        body: { items: [item("allow-no", "one@example.test")] },
      }),
      { ses: fixture.ses, allowance: recordingAllowance("refuse") },
    );

    expect(response.status).toBe(402);
    expect(batchCalls(fixture.ses)).toHaveLength(0);
    expect(await idempotencyRows(fixture.environmentId)).toHaveLength(0);
  });
});

describe("POST /api/email/send-batch — the route as Next runs it", () => {
  it("wires the handler to the process-wide SES client", async () => {
    const fixture = await seed();
    const ses = getFakeSesClient("us");
    await makeSendReady(ses, fixture.tenantName);
    const before = ses.__sent().length;

    const response = await batchRoute(
      batchRequest({
        token: fixture.token,
        body: { items: [item("route-batch", "one@example.test")] },
      }),
    );

    expect(response.status).toBe(200);
    expect(await results(response)).toEqual([
      { status: "sent", id: expect.any(String) },
    ]);
    expect(ses.__sent()).toHaveLength(before + 1);
  });
});
