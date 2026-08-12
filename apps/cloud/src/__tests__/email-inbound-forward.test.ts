import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailInboundMessages,
  environments,
  organizations,
  sesTenants,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { encryptSecretPayload } from "../lib/crypto";
import {
  handleSesInboundNotification,
  type SesInboundIngressDeps,
} from "../lib/email-inbound-ingress";
import { INBOUND_OBJECT_KEY_PREFIX } from "../lib/inbound-domains";
import {
  buildForwardMessage,
  forwardFromAddress,
  INBOUND_FORWARD_LOCAL_PART,
} from "../lib/inbound-forward";
import { forwardInboundMessage } from "../services/email-inbound-forward";
import {
  createInboundObjectFetcher,
  type InboundS3Transport,
} from "../services/email-inbound-objects";
import { writeInboundConfig } from "../services/ses-inbound-config";
import { FakeSesClient } from "../ses/fake";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { SesError } from "../ses/types";
import { SNS_TEST_CERT_PEM, snsNotification } from "./helpers/sns-envelope";

/**
 * THE MANDATORY FORWARD (PRD 16 task 6), end to end.
 *
 * PRD 16's line, which is the whole reason this file exists: "A person replying
 * to a human expects a human to read it. If we intercept a reply and only emit
 * an event, we have broken their business to gain a feature."
 *
 * So the three EARS this asserts are all about the message reaching a PERSON,
 * and each one fails silently if it regresses:
 *
 *  1. every received message is forwarded — including the ones that produce NO
 *     event (an auto-responder, a message too large to read). Those are the
 *     cases a "forward the ones we emitted for" implementation passes every
 *     test on and still swallows a customer's mail;
 *  2. a forwarding failure loses NEITHER the stored message NOR the event —
 *     forwarding is a side effect, never a gate;
 *  3. enabling inbound without a forwarding address is REFUSED outright, at
 *     enable time, because that configuration is the silent swallow itself.
 *     (The refusal lives in `ses-inbound-domains.test.ts`, which owns `enable`;
 *     what is asserted here is the receive-side half of the same invariant —
 *     that a resolved message always HAS an address to go to.)
 *
 * Nothing here reaches AWS: the SNS certificate, the S3 read and the SES send
 * are all injected, and the ingress' default `fetchImpl` throws.
 */

const ORG = "email-inbound-forward-test-org";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-ses-inbound-us";
const BUCKET = "hogsend-ses-inbound";
const DOMAIN = "fwd-tenant.test";
const HUMAN = `support@${DOMAIN}`;
const INSTANCE = "https://fwd-tenant.hogsend.app";
const SECRET = "fwd-tenant-webhook-secret-abcdefghij";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

let seq = 0;

function freshMessageId(): string {
  seq += 1;
  return `0100029${String(seq).padStart(4, "0")}-forward-test-000000`;
}

function receivedNotification(opts: {
  messageId: string;
  recipients: string[];
}): Record<string, unknown> {
  return {
    notificationType: "Received",
    mail: {
      timestamp: "2026-08-12T09:15:00.000Z",
      source: "human@sender.test",
      messageId: opts.messageId,
      destination: opts.recipients,
      headersTruncated: false,
      headers: [],
      commonHeaders: {},
    },
    receipt: {
      timestamp: "2026-08-12T09:15:00.000Z",
      processingTimeMillis: 111,
      recipients: opts.recipients,
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      action: {
        type: "S3",
        topicArn: TOPIC_ARN,
        bucketName: BUCKET,
        objectKeyPrefix: INBOUND_OBJECT_KEY_PREFIX,
        objectKey: `${INBOUND_OBJECT_KEY_PREFIX}${opts.messageId}`,
      },
    },
  };
}

function rawMessage(opts: {
  from?: string;
  subject?: string;
  text?: string;
  headers?: Record<string, string>;
}): Uint8Array {
  const headers: Record<string, string> = {
    From: opts.from ?? "Human Sender <human@sender.test>",
    To: `hello@reply.${DOMAIN}`,
    Subject: opts.subject ?? "Re: your onboarding email",
    Date: "Wed, 12 Aug 2026 09:14:00 +0000",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
    ...opts.headers,
  };
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  const body = opts.text ?? "Please stop emailing me.";
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n${body}\r\n`);
}

function fakeS3(objects: Map<string, { size: number; body?: Uint8Array }>) {
  const transport: InboundS3Transport = {
    async head(ref) {
      const object = objects.get(ref.key);
      if (!object) throw new Error(`no such key: ${ref.key}`);
      return { size: object.size };
    },
    async get(ref) {
      const object = objects.get(ref.key);
      if (!object?.body) throw new Error(`no body for key: ${ref.key}`);
      return { body: object.body };
    },
  };
  return createInboundObjectFetcher(() => transport);
}

let environmentId: string;

/** A fake in the state a fully provisioned, send-ready environment is in. */
async function sendReadyFake(): Promise<FakeSesClient> {
  const ses = new FakeSesClient({ region: "us" });
  const tenantName = sesTenantName(environmentId);
  await ses.createTenant({ tenantName });
  await ses.createIdentity({ domain: DOMAIN });
  ses.__verifyIdentity(DOMAIN);
  await ses.associateResource({ tenantName, resourceArn: IDENTITY_ARN });
  return ses;
}

/**
 * One received message all the way through, with the REAL forwarder wired to a
 * fake SES.
 *
 * The forward is injected as `forwardInboundMessage` bound to a fake client
 * rather than replaced by a stub, so what these tests exercise is the shipped
 * ordering, the shipped `forwarded_at` guard and the shipped message builder.
 */
async function receive(opts: {
  raw?: Uint8Array;
  size?: number;
  recipients?: string[];
  ses?: FakeSesClient;
  responses?: Array<Response | (() => Response)>;
  deps?: Partial<SesInboundIngressDeps>;
  maxObjectBytes?: number;
}) {
  const messageId = freshMessageId();
  const key = `${INBOUND_OBJECT_KEY_PREFIX}${messageId}`;
  const raw = opts.raw ?? rawMessage({});
  const ses = opts.ses ?? (await sendReadyFake());

  let index = 0;
  const fetchImpl = (async () => {
    const next =
      opts.responses?.[Math.min(index, (opts.responses?.length ?? 1) - 1)];
    index += 1;
    if (!next)
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return typeof next === "function" ? next() : next.clone();
  }) as unknown as typeof fetch;

  const response = await handleSesInboundNotification(
    new Request("https://cloud.hogsend.com/api/email/inbound/us", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(
        snsNotification(
          receivedNotification({
            messageId,
            recipients: opts.recipients ?? [`hello@reply.${DOMAIN}`],
          }),
          { topicArn: TOPIC_ARN },
        ),
      ),
    }),
    "us",
    {
      db,
      store: { bucketName: BUCKET, topicArn: TOPIC_ARN },
      fetchCertificatePem: async () => SNS_TEST_CERT_PEM,
      fetchObject: fakeS3(
        new Map([[key, { size: opts.size ?? raw.byteLength, body: raw }]]),
      ),
      fetchImpl,
      sleep: async () => {},
      ...(opts.maxObjectBytes ? { maxObjectBytes: opts.maxObjectBytes } : {}),
      forward: (input) => forwardInboundMessage(input, { db, ses }),
      ...opts.deps,
    },
  );

  return {
    messageId,
    ses,
    response,
    body: (await response.clone().json()) as Record<string, unknown>,
    row: async () => {
      const [row] = await db
        .select()
        .from(emailInboundMessages)
        .where(eq(emailInboundMessages.sesMessageId, messageId));
      return row;
    },
  };
}

/** Every message the fake actually accepted for delivery. */
function forwards(ses: FakeSesClient) {
  return ses.__sent();
}

async function cleanup(): Promise<void> {
  await db
    .delete(emailInboundMessages)
    .where(eq(emailInboundMessages.region, "us"));
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Email Inbound Forward Test", region: "us" });

  const [environment] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: "fwd-env", kind: "test" })
    .returning();
  if (!environment) throw new Error("failed to seed environment");
  environmentId = environment.id;

  await db.insert(stacks).values({
    organizationId: ORG,
    environmentId,
    region: "us",
    status: "running",
    substrateRefs: { substrate: "fake", apiPublicUrl: INSTANCE, data: {} },
  });
  await db.insert(sesTenants).values({
    environmentId,
    tenantName: sesTenantName(environmentId),
    tenantArn: `arn:aws:ses:us-east-1:123456789012:tenant/${sesTenantName(
      environmentId,
    )}`,
    configurationSetName: sesConfigurationSetName(environmentId),
    region: "us",
    awsRegion: "us-east-1",
    webhookSecretEncrypted: encryptSecretPayload(SECRET),
    available: true,
  });
  await writeInboundConfig(
    {
      environmentId,
      domain: DOMAIN,
      config: { forwardTo: HUMAN, label: "reply" },
    },
    { db },
  );
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

// ---------------------------------------------------------------------------
// EARS: every received message is forwarded to the configured human address
// ---------------------------------------------------------------------------

describe("the mandatory forward", () => {
  it("sends every received reply to the configured human address", async () => {
    const result = await receive({});

    expect(result.body.action).toBe("delivered");
    const sent = forwards(result.ses);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.to).toEqual([HUMAN]);
    // Stamped, so a re-drive does not send it twice.
    expect((await result.row())?.forwardedAt).toBeInstanceOf(Date);
    expect((await result.row())?.forwardError).toBeNull();
  });

  it("goes out under the CUSTOMER's verified domain, replying to the sender", async () => {
    // Not our domain, and not the envelope recipient's attacker-chosen local
    // part: the apex sending domain is the identity SES actually verified, and
    // a fixed local part means nothing a stranger typed becomes a header we
    // emit. `Reply-To` is what keeps it a conversation — the human hits reply
    // and reaches the person who wrote to them, not Hogsend.
    const result = await receive({});

    const message = forwards(result.ses)[0]?.message;
    expect(message?.from).toBe(`${INBOUND_FORWARD_LOCAL_PART}@${DOMAIN}`);
    expect(message?.replyTo).toEqual(["human@sender.test"]);
    // It goes through the TENANT's own SES tenant, so a stranger's words never
    // land on Hogsend's own sending reputation.
    expect(forwards(result.ses)[0]?.tenantName).toBe(
      sesTenantName(environmentId),
    );
  });

  it("carries the sender, the subject and the text a human needs", async () => {
    const result = await receive({
      raw: rawMessage({ subject: "Re: onboarding", text: "please stop" }),
    });

    const message = forwards(result.ses)[0]?.message;
    expect(message?.subject).toBe("Fwd: Re: onboarding");
    expect(message?.text).toContain("human@sender.test");
    expect(message?.text).toContain("please stop");
    // The reference, so the customer can opt in to retrieving the original.
    expect(message?.text).toContain(`s3://${BUCKET}/`);
    // NEVER the raw markup. Forwarding a stranger's HTML into a mailbox we
    // send from is a surface with no upside.
    expect(message?.html).toBeUndefined();
  });

  it("forwards an AUTO-RESPONDER, which emits no event at all", async () => {
    // THE case a "forward what we emitted" implementation gets wrong. The loop
    // guard refuses to emit — correctly — and the human must still receive
    // their correspondent's out-of-office.
    const result = await receive({
      raw: rawMessage({ headers: { "Auto-Submitted": "auto-replied" } }),
      responses: [
        new Response(JSON.stringify({ error: "no event expected" }), {
          status: 500,
        }),
      ],
    });

    expect(result.body.action).toBe("suppressed");
    expect(result.body.reason).toBe("auto_submitted");
    const sent = forwards(result.ses);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.to).toEqual([HUMAN]);
    // And it says so, rather than looking like an ordinary forward.
    expect(sent[0]?.message.text).toContain("auto_submitted");
  });

  it("forwards a notice for a message too large to even read", async () => {
    // No parse happened, so there is no text to forward — but "somebody
    // replied and we could not process it" is exactly what a customer must be
    // told rather than shielded from.
    const result = await receive({
      size: 40 * 1024 * 1024,
      maxObjectBytes: 1024,
    });

    expect(result.body.reason).toBe("too_large");
    const sent = forwards(result.ses);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.text).toContain("could not read this message");
    expect(sent[0]?.message.text).toContain(`s3://${BUCKET}/`);
  });

  it("forwards even when the tenant's instance is DOWN", async () => {
    // The human's mail must not wait on the customer's own deploy. The event
    // is retryable; the forward already happened.
    const result = await receive({
      responses: [new Response("nope", { status: 500 })],
    });

    expect(result.response.status).toBe(502);
    expect(forwards(result.ses)).toHaveLength(1);
  });

  it("WAITS rather than apologising when the read is merely transient", async () => {
    // The one case that must not forward on this pass. S3 failed, so there is
    // no message to forward — only a "we could not read it" notice. Sending
    // that would stamp `forwarded_at`, and the redelivery that then succeeds
    // would find the message already forwarded and stay silent: the human
    // would receive the apology INSTEAD OF the reply.
    const ses = await sendReadyFake();
    const messageId = freshMessageId();
    const response = await handleSesInboundNotification(
      new Request("https://cloud.hogsend.com/api/email/inbound/us", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(
          snsNotification(
            receivedNotification({
              messageId,
              recipients: [`hello@reply.${DOMAIN}`],
            }),
            { topicArn: TOPIC_ARN },
          ),
        ),
      }),
      "us",
      {
        db,
        store: { bucketName: BUCKET, topicArn: TOPIC_ARN },
        fetchCertificatePem: async () => SNS_TEST_CERT_PEM,
        // An empty S3: the HEAD throws, which is "we could not read it".
        fetchObject: fakeS3(new Map()),
        fetchImpl: (async () =>
          new Response("{}", { status: 200 })) as unknown as typeof fetch,
        sleep: async () => {},
        forward: (input) => forwardInboundMessage(input, { db, ses }),
      },
    );

    expect(response.status).toBe(502);
    expect(forwards(ses)).toEqual([]);
    const [row] = await db
      .select()
      .from(emailInboundMessages)
      .where(eq(emailInboundMessages.sesMessageId, messageId));
    // Nothing stamped, so the redelivery that CAN read the message is still
    // the one that will forward it.
    expect(row?.forwardedAt).toBeNull();
    expect(row?.forwardError).toBeNull();
  });

  it("does NOT forward a message that belongs to nobody", async () => {
    // An unresolved recipient has no configured address, and broadcasting is
    // never the answer.
    const result = await receive({
      recipients: ["hello@reply.nobody-here.test"],
    });

    expect(result.body.action).toBe("dropped");
    expect(forwards(result.ses)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EARS: a forwarding failure loses neither the stored message nor the event
// ---------------------------------------------------------------------------

describe("a forwarding failure", () => {
  it("keeps the stored message AND the delivered event, and records why", async () => {
    const ses = await sendReadyFake();
    ses.failNext(
      "sendEmail",
      new SesError("fake SES: the wire is down", {
        kind: "throttled",
        operation: "sendEmail",
      }),
    );

    const result = await receive({ ses });

    // The event still went out — a 200 with `delivered`, exactly as if the
    // forward had succeeded. Forwarding is a side effect, never a gate.
    expect(result.response.status).toBe(200);
    expect(result.body.action).toBe("delivered");

    const row = await result.row();
    // The stored message is untouched and still terminal-delivered.
    expect(row?.status).toBe("delivered");
    expect(row?.objectKey).toContain(INBOUND_OBJECT_KEY_PREFIX);
    // And the failure is ON THE ROW, not only in a log line: an operator can
    // list `forwarded_at IS NULL AND forward_error IS NOT NULL` and re-drive.
    expect(row?.forwardedAt).toBeNull();
    expect(row?.forwardError).toContain("the wire is down");
  });

  it("records the failure without touching last_error", async () => {
    // The two columns answer different questions — "why did the instance not
    // take the event" vs "why did the human not get the message" — and a reply
    // can easily do one and not the other. Sharing a column would let the
    // successful half erase the evidence of the failed one.
    const ses = await sendReadyFake();
    ses.failNext(
      "sendEmail",
      new SesError("fake SES: forward refused", {
        kind: "throttled",
        operation: "sendEmail",
      }),
    );

    const row = await (await receive({ ses })).row();
    expect(row?.forwardError).toContain("forward refused");
    expect(row?.lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: a re-drive must not put the same message in a person's inbox
// twice
// ---------------------------------------------------------------------------

describe("forward idempotency", () => {
  it("does not forward twice when the row is already stamped", async () => {
    const ses = await sendReadyFake();
    const result = await receive({ ses });
    const row = await result.row();
    expect(row).toBeDefined();
    if (!row) throw new Error("no row");

    const again = await forwardInboundMessage(
      {
        rowId: row.id,
        region: "us",
        environmentId,
        domain: DOMAIN,
        forwardTo: HUMAN,
        recipient: row.recipient,
        parsed: null,
        storage: { bucket: row.bucket, key: row.objectKey },
      },
      { db, ses },
    );

    expect(again).toEqual({ status: "already_forwarded" });
    expect(forwards(ses)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The message itself — asserted directly, so the shape is pinned without an
// end-to-end run
// ---------------------------------------------------------------------------

describe("buildForwardMessage", () => {
  const parsed = {
    messageId: "sender-own-id",
    from: "human@sender.test",
    subject: "Re: hello",
    text: "hi there",
    textTruncated: false,
    correlationCandidates: [],
    inReplyTo: null,
    attachments: [
      { filename: "invoice.pdf", contentType: "application/pdf", size: 1234 },
    ],
    attachmentsTruncated: false,
    autoSubmitted: null,
    precedence: null,
  };

  it("marks itself auto-forwarded, so it cannot start a mail loop", () => {
    // RFC 3834. This forward IS an automatic message: without the header an
    // out-of-office on the human's mailbox can answer it, that answer lands
    // back on `reply.<domain>`, and the two systems talk to each other. It is
    // the same loop the receive path's guard breaks from the other side.
    const message = buildForwardMessage({
      domain: DOMAIN,
      forwardTo: HUMAN,
      recipient: `hello@reply.${DOMAIN}`,
      parsed,
      storage: { bucket: BUCKET, key: "inbound/x" },
    });

    expect(message.headers?.["Auto-Submitted"]).toBe("auto-forwarded");
  });

  it("lists attachments by name and size, and carries no bytes", () => {
    const message = buildForwardMessage({
      domain: DOMAIN,
      forwardTo: HUMAN,
      recipient: `hello@reply.${DOMAIN}`,
      parsed,
      storage: { bucket: BUCKET, key: "inbound/x" },
    });

    expect(message.text).toContain("invoice.pdf");
    expect(message.text).toContain("1234 bytes");
    expect(message.attachments).toBeUndefined();
  });

  it("DROPS an unusable sender address rather than failing the forward", () => {
    // A `Reply-To` we cannot use is worth losing; the forward is not. The
    // address is the one field on this message a stranger wrote.
    const message = buildForwardMessage({
      domain: DOMAIN,
      forwardTo: HUMAN,
      recipient: `hello@reply.${DOMAIN}`,
      parsed: { ...parsed, from: "not an address" },
      storage: { bucket: BUCKET, key: "inbound/x" },
    });

    expect(message.replyTo).toBeUndefined();
    expect(message.to).toEqual([HUMAN]);
  });

  it("sends from the apex sending domain, never the reply subdomain", () => {
    expect(forwardFromAddress(DOMAIN)).toBe(
      `${INBOUND_FORWARD_LOCAL_PART}@${DOMAIN}`,
    );
    expect(forwardFromAddress(DOMAIN)).not.toContain("reply.");
  });
});
