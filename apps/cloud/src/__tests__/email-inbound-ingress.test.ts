import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  verifyHogsendRelaySignature,
} from "@hogsend/plugin-hogsend";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailEvents,
  emailIdempotency,
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
  createInboundObjectFetcher,
  type InboundS3Transport,
} from "../services/email-inbound-objects";
import { writeInboundConfig } from "../services/ses-inbound-config";
import { sesTenantName } from "../ses/names";
import { SNS_TEST_CERT_PEM, snsNotification } from "./helpers/sns-envelope";

/**
 * THE INBOUND RECEIVE ENDPOINT, end to end (PRD 16 task 4).
 *
 * Nothing here reaches the network: the SNS certificate fetch, the S3 read and
 * the outbound instance hop are all injected. The default `fetchImpl` THROWS,
 * so a test that forgets to inject one fails loudly instead of quietly dialling
 * a real host.
 *
 * The suite is organized around the refusals, because every one of them is a
 * thing that is silent when it breaks: a message accepted on a forged
 * signature, a message attributed to the wrong tenant, an auto-responder that
 * starts a mail loop, a 40 MB object pulled into a request handler.
 */

const ORG = "email-inbound-ingress-test-org";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-ses-inbound-us";
const OTHER_TOPIC = "arn:aws:sns:us-east-1:999999999999:somebody-elses-topic";
const BUCKET = "hogsend-ses-inbound";
const A_DOMAIN = "a-tenant.test";
const B_DOMAIN = "b-tenant.test";
const A_INSTANCE = "https://a-tenant.hogsend.app";
const B_INSTANCE = "https://b-tenant.hogsend.app";
const A_SECRET = "a-tenant-webhook-secret-abcdefghij";
const B_SECRET = "b-tenant-webhook-secret-klmnopqrst";

// ---------------------------------------------------------------------------
// Fixtures: the SES notification and the raw MIME behind it
// ---------------------------------------------------------------------------

let seq = 0;

function freshMessageId(): string {
  seq += 1;
  return `0100019${String(seq).padStart(4, "0")}-inbound-test-000000`;
}

function objectKeyFor(messageId: string): string {
  return `${INBOUND_OBJECT_KEY_PREFIX}${messageId}`;
}

/** SES's own `Received` notification shape, with the S3 store action. */
function receivedNotification(opts: {
  messageId: string;
  recipients: string[];
  /** `mail.destination` — the sender-written `To:`, distinct from the envelope. */
  destination?: string[];
  bucket?: string;
  objectKey?: string;
}): Record<string, unknown> {
  return {
    notificationType: "Received",
    mail: {
      timestamp: "2026-08-11T09:15:00.000Z",
      source: "human@sender.test",
      messageId: opts.messageId,
      destination: opts.destination ?? opts.recipients,
      headersTruncated: false,
      headers: [],
      commonHeaders: {},
    },
    receipt: {
      timestamp: "2026-08-11T09:15:00.000Z",
      processingTimeMillis: 222,
      recipients: opts.recipients,
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: "PASS" },
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      action: {
        type: "S3",
        topicArn: TOPIC_ARN,
        bucketName: opts.bucket ?? BUCKET,
        objectKeyPrefix: INBOUND_OBJECT_KEY_PREFIX,
        objectKey: opts.objectKey ?? objectKeyFor(opts.messageId),
      },
    },
  };
}

/** A plain RFC 5322 message, headers written verbatim so a test can forge one. */
function rawMessage(opts: {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  headers?: Record<string, string>;
}): Uint8Array {
  const headers: Record<string, string> = {
    From: opts.from ?? "Human Sender <human@sender.test>",
    To: opts.to ?? `hello@reply.${A_DOMAIN}`,
    Subject: opts.subject ?? "Re: your onboarding email",
    Date: "Tue, 11 Aug 2026 09:14:00 +0000",
    "MIME-Version": "1.0",
    "Content-Type": 'text/plain; charset="utf-8"',
    ...opts.headers,
  };
  const lines = Object.entries(headers).map(
    ([key, value]) => `${key}: ${value}`,
  );
  const body = opts.text ?? "Please stop emailing me.";
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n${body}\r\n`);
}

/** A two-part message carrying one attachment, so the manifest has something. */
function rawMessageWithAttachment(): Uint8Array {
  const boundary = "----hogsend-test-boundary";
  const attachmentBytes = Buffer.from("PDF-ish bytes, 32 of them exactly!!");
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "See attached.",
    `--${boundary}`,
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    attachmentBytes.toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const headers = [
    "From: Human Sender <human@sender.test>",
    `To: hello@reply.${A_DOMAIN}`,
    "Subject: Re: invoice",
    "Date: Tue, 11 Aug 2026 09:14:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  return new TextEncoder().encode(`${headers}\r\n\r\n${body}`);
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

interface Delivery {
  url: string;
  body: string;
  signature: string;
}

function recordingFetch(responses: Array<Response | (() => Response)> = []): {
  fetchImpl: typeof fetch;
  deliveries: Delivery[];
} {
  const deliveries: Delivery[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    deliveries.push({
      url: String(input),
      body: String(init?.body ?? ""),
      signature: headers.get(HOGSEND_RELAY_SIGNATURE_HEADER) ?? "",
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next)
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return typeof next === "function" ? next() : next.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, deliveries };
}

/**
 * A fake S3 that COUNTS its verbs.
 *
 * Driven through the REAL `createInboundObjectFetcher`, so the HEAD-before-GET
 * ordering under test is the production one and not a re-implementation.
 */
function fakeS3(objects: Map<string, { size: number; body?: Uint8Array }>) {
  const calls: string[] = [];
  const transport: InboundS3Transport = {
    async head(ref) {
      calls.push(`head:${ref.key}`);
      const object = objects.get(ref.key);
      if (!object) throw new Error(`no such key: ${ref.key}`);
      return { size: object.size };
    },
    async get(ref) {
      calls.push(`get:${ref.key}`);
      const object = objects.get(ref.key);
      if (!object?.body) throw new Error(`no body for key: ${ref.key}`);
      return { body: object.body };
    },
  };
  return {
    calls,
    fetcher: createInboundObjectFetcher(() => transport),
  };
}

function request(body: unknown, region = "us"): Request {
  return new Request(`https://cloud.hogsend.com/api/email/inbound/${region}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
  });
}

function refuseFetch(): typeof fetch {
  return (async () => {
    throw new Error("a test reached the network; inject fetchImpl");
  }) as unknown as typeof fetch;
}

function deps(
  overrides: Partial<SesInboundIngressDeps> = {},
): SesInboundIngressDeps {
  return {
    db,
    store: { bucketName: BUCKET, topicArn: TOPIC_ARN },
    fetchCertificatePem: async () => SNS_TEST_CERT_PEM,
    fetchImpl: refuseFetch(),
    sleep: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

interface Tenant {
  environmentId: string;
  domain: string;
  instanceUrl: string;
  secret: string;
}

async function seedTenant(input: {
  name: string;
  domain: string;
  instanceUrl: string;
  secret: string;
  label?: string;
}): Promise<Tenant> {
  const [environment] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: input.name, kind: "test" })
    .returning();
  if (!environment) throw new Error("failed to seed environment");

  await db.insert(stacks).values({
    organizationId: ORG,
    environmentId: environment.id,
    region: "us",
    status: "running",
    substrateRefs: {
      substrate: "fake",
      apiPublicUrl: input.instanceUrl,
      data: {},
    },
  });

  await db.insert(sesTenants).values({
    environmentId: environment.id,
    tenantName: sesTenantName(environment.id),
    tenantArn: `arn:aws:ses:us-east-1:123456789012:tenant/${sesTenantName(
      environment.id,
    )}`,
    configurationSetName: sesTenantName(environment.id),
    region: "us",
    awsRegion: "us-east-1",
    webhookSecretEncrypted: encryptSecretPayload(input.secret),
    available: true,
  });

  // Through the REAL service, so the resolver is exercised against the shape
  // task 3 actually writes rather than against a hand-made row.
  await writeInboundConfig(
    {
      environmentId: environment.id,
      domain: input.domain,
      config: {
        forwardTo: `human@${input.domain}`,
        label: input.label ?? "reply",
      },
    },
    { db },
  );

  return {
    environmentId: environment.id,
    domain: input.domain,
    instanceUrl: input.instanceUrl,
    secret: input.secret,
  };
}

/** Record that this environment sent `messageId`, the way the relay does. */
async function seedSend(environmentId: string, messageId: string) {
  await db.insert(emailIdempotency).values({
    environmentId,
    idempotencyKey: `key-${messageId}`,
    messageId,
  });
}

async function inboundRows(sesMessageId: string) {
  return db
    .select()
    .from(emailInboundMessages)
    .where(eq(emailInboundMessages.sesMessageId, sesMessageId));
}

let tenantA: Tenant;
let tenantB: Tenant;

async function cleanup(): Promise<void> {
  await db
    .delete(emailInboundMessages)
    .where(eq(emailInboundMessages.region, "us"));
  await db.delete(emailEvents).where(eq(emailEvents.region, "us"));
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Email Inbound Ingress Test", region: "us" });
  tenantA = await seedTenant({
    name: "inbound-env-a",
    domain: A_DOMAIN,
    instanceUrl: A_INSTANCE,
    secret: A_SECRET,
  });
  tenantB = await seedTenant({
    name: "inbound-env-b",
    domain: B_DOMAIN,
    instanceUrl: B_INSTANCE,
    secret: B_SECRET,
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

/**
 * One received message, all the way through: seed the object, POST the signed
 * notification, hand back everything a test wants to assert on.
 */
async function receive(opts: {
  raw?: Uint8Array;
  /** Overrides the object's reported size, so the cap is testable cheaply. */
  size?: number;
  recipients?: string[];
  destination?: string[];
  bucket?: string;
  sign?: boolean;
  topicArn?: string;
  region?: string;
  deps?: Partial<SesInboundIngressDeps>;
  responses?: Array<Response | (() => Response)>;
}) {
  const messageId = freshMessageId();
  const key = objectKeyFor(messageId);
  const raw = opts.raw ?? rawMessage({});
  const s3 = fakeS3(
    new Map([[key, { size: opts.size ?? raw.byteLength, body: raw }]]),
  );
  const net = recordingFetch(opts.responses);

  const response = await handleSesInboundNotification(
    request(
      snsNotification(
        receivedNotification({
          messageId,
          recipients: opts.recipients ?? [`hello@reply.${A_DOMAIN}`],
          destination: opts.destination,
          bucket: opts.bucket,
        }),
        { topicArn: opts.topicArn ?? TOPIC_ARN, sign: opts.sign },
      ),
      opts.region,
    ),
    opts.region ?? "us",
    deps({ fetchObject: s3.fetcher, fetchImpl: net.fetchImpl, ...opts.deps }),
  );

  return {
    messageId,
    response,
    body: (await response.clone().json()) as Record<string, unknown>,
    deliveries: net.deliveries,
    s3Calls: s3.calls,
    rows: async () => inboundRows(messageId),
  };
}

/** The single delivered payload, parsed. */
function payloadOf(deliveries: Delivery[]): Record<string, unknown> {
  const delivery = deliveries[0];
  if (!delivery) throw new Error("nothing was delivered");
  return JSON.parse(delivery.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Refusals: nothing hostile gets as far as S3
// ---------------------------------------------------------------------------

describe("refusal", () => {
  it("404s a region we do not serve", async () => {
    const result = await receive({ region: "moon" });
    expect(result.response.status).toBe(404);
    expect(result.s3Calls).toEqual([]);
  });

  it("403s a forged signature, and reads NOTHING from S3", async () => {
    const result = await receive({ sign: false });

    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe("sns_signature");
    // The whole point: the object was never named to S3, let alone fetched.
    expect(result.s3Calls).toEqual([]);
    expect(result.deliveries).toEqual([]);
    expect(await result.rows()).toHaveLength(0);
  });

  it("403s a message on somebody else's topic", async () => {
    const result = await receive({ topicArn: OTHER_TOPIC });

    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe("unknown_topic");
    expect(result.s3Calls).toEqual([]);
    expect(await result.rows()).toHaveLength(0);
  });

  it("FAILS CLOSED when the region has no inbound store configured", async () => {
    // The topic on the message is the RIGHT one. With no configured store there
    // is no such thing as a right one, so it is still refused - the inverse
    // would turn a missing environment variable into an open ingest endpoint.
    const result = await receive({ deps: { store: null } });

    expect(result.response.status).toBe(403);
    expect(result.body.error).toBe("unknown_topic");
    expect(result.s3Calls).toEqual([]);
  });

  it("ignores a notification naming a bucket we did not provision", async () => {
    const result = await receive({ bucket: "somebody-elses-bucket" });

    // 200 so SNS stops, `ignored` so an operator can find it, and no read.
    expect(result.response.status).toBe(200);
    expect(result.body.reason).toBe("foreign_bucket");
    expect(result.s3Calls).toEqual([]);
    expect(await result.rows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("a reply", () => {
  it("correlates to its send, stores it, and emits email.replied", async () => {
    const sent = `0100018correlates-${Date.now()}-000000`;
    await seedSend(tenantA.environmentId, sent);

    const result = await receive({
      raw: rawMessage({
        text: "Yes please, that works.",
        headers: { "In-Reply-To": `<${sent}@us-east-1.amazonses.com>` },
      }),
    });

    expect(result.response.status).toBe(200);
    expect(result.body.action).toBe("delivered");

    const [row] = await result.rows();
    expect(row?.environmentId).toBe(tenantA.environmentId);
    expect(row?.domain).toBe(A_DOMAIN);
    expect(row?.status).toBe("delivered");
    expect(row?.correlated).toBe(true);
    expect(row?.correlatedMessageId).toBe(sent);
    expect(row?.fromAddress).toBe("human@sender.test");
    expect(row?.subject).toBe("Re: your onboarding email");
    // The reference is kept; the bytes are not.
    expect(row?.bucket).toBe(BUCKET);
    expect(row?.objectKey).toBe(objectKeyFor(result.messageId));

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.url).toBe(
      `${A_INSTANCE}/v1/webhooks/email/hogsend`,
    );
    // Signed with THIS tenant's secret, verified with the engine's own function.
    expect(
      verifyHogsendRelaySignature({
        payload: result.deliveries[0]?.body ?? "",
        secret: A_SECRET,
        signature: result.deliveries[0]?.signature ?? "",
      }),
    ).toBe(true);

    const payload = payloadOf(result.deliveries);
    expect(payload.type).toBe("email.replied");
    expect(payload.correlated).toBe(true);
    expect(payload.inReplyTo).toBe(sent);
    expect(payload.text).toContain("Yes please");
    expect(payload.recipient).toBe(`hello@reply.${A_DOMAIN}`);
    expect(payload.storage).toMatchObject({
      bucket: BUCKET,
      key: objectKeyFor(result.messageId),
    });
  });

  it("correlates through References when In-Reply-To is absent", async () => {
    const parent = `0100018references-${Date.now()}-000000`;
    await seedSend(tenantA.environmentId, parent);

    const result = await receive({
      raw: rawMessage({
        headers: {
          // RFC 5322 orders References oldest-first, so the PARENT is last.
          References: `<older@sender.test> <${parent}@us-east-1.amazonses.com>`,
        },
      }),
    });

    const [row] = await result.rows();
    expect(row?.correlated).toBe(true);
    expect(row?.correlatedMessageId).toBe(parent);
  });

  it("correlates through email_events when the idempotency row is gone", async () => {
    // The relay prunes `email_idempotency` after seven days. A reply to a
    // three-week-old email must still correlate, or the feature quietly stops
    // working for exactly the long sequences it exists to serve.
    const sent = `0100018evented-${Date.now()}-000000`;
    await db.insert(emailEvents).values({
      environmentId: tenantA.environmentId,
      tenantName: sesTenantName(tenantA.environmentId),
      region: "us",
      dedupeKey: `dedupe-${sent}`,
      type: "email.delivered",
      messageId: sent,
      payload: {},
      status: "delivered",
      occurredAt: new Date(),
    });

    const result = await receive({
      raw: rawMessage({
        headers: { "In-Reply-To": `<${sent}@us-east-1.amazonses.com>` },
      }),
    });

    const [row] = await result.rows();
    expect(row?.correlated).toBe(true);
    expect(row?.correlatedMessageId).toBe(sent);
  });

  it("is STILL stored and delivered when it cannot be correlated", async () => {
    const result = await receive({
      raw: rawMessage({ text: "Who is this?" }),
    });

    expect(result.body.action).toBe("delivered");

    const [row] = await result.rows();
    expect(row?.status).toBe("delivered");
    expect(row?.correlated).toBe(false);
    expect(row?.correlatedMessageId).toBeNull();

    const payload = payloadOf(result.deliveries);
    expect(payload.correlated).toBe(false);
    // ABSENT, not null: the engine must not be able to key on an id we did not
    // prove.
    expect("inReplyTo" in payload).toBe(false);
    expect(payload.text).toContain("Who is this?");
  });

  it("lists attachments by name and size, and carries no bytes", async () => {
    const result = await receive({ raw: rawMessageWithAttachment() });

    const [row] = await result.rows();
    expect(row?.attachments).toEqual([
      { filename: "invoice.pdf", contentType: "application/pdf", size: 35 },
    ]);

    const payload = payloadOf(result.deliveries);
    expect(payload.attachments).toEqual([
      { filename: "invoice.pdf", contentType: "application/pdf", size: 35 },
    ]);
    // No base64 of the attachment anywhere on the wire.
    expect(result.deliveries[0]?.body).not.toContain(
      Buffer.from("PDF-ish bytes, 32 of them exactly!!").toString("base64"),
    );
  });

  it("collapses an SNS redelivery to one event", async () => {
    const messageId = freshMessageId();
    const key = objectKeyFor(messageId);
    const raw = rawMessage({});
    const s3 = fakeS3(new Map([[key, { size: raw.byteLength, body: raw }]]));
    const net = recordingFetch();

    const send = () =>
      handleSesInboundNotification(
        request(
          snsNotification(
            receivedNotification({
              messageId,
              recipients: [`hello@reply.${A_DOMAIN}`],
            }),
            { topicArn: TOPIC_ARN },
          ),
        ),
        "us",
        deps({ fetchObject: s3.fetcher, fetchImpl: net.fetchImpl }),
      );

    const first = (await (await send()).json()) as Record<string, unknown>;
    const second = (await (await send()).json()) as Record<string, unknown>;

    expect(first.action).toBe("delivered");
    expect(second.action).toBe("duplicate");
    expect(net.deliveries).toHaveLength(1);
    expect(await inboundRows(messageId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE TENANT BOUNDARY
// ---------------------------------------------------------------------------

describe("the tenant boundary", () => {
  it("does not let a forged In-Reply-To attach a reply to another tenant's send", async () => {
    // Tenant B genuinely sent this. Nobody outside B may name it.
    const bsSend = `0100018forged-${Date.now()}-000000`;
    await seedSend(tenantB.environmentId, bsSend);

    // The message arrives at TENANT A's reply address, claiming to answer B's.
    const result = await receive({
      raw: rawMessage({
        headers: { "In-Reply-To": `<${bsSend}@us-east-1.amazonses.com>` },
      }),
    });

    const [row] = await result.rows();
    // Attributed by the ENVELOPE recipient, which SES asserted.
    expect(row?.environmentId).toBe(tenantA.environmentId);
    // The claim is recorded, and it is recorded as a CLAIM.
    expect(row?.inReplyTo).toBe(`${bsSend}@us-east-1.amazonses.com`);
    // ...and it bought nothing.
    expect(row?.correlated).toBe(false);
    expect(row?.correlatedMessageId).toBeNull();

    // Delivered to A, never to B, and carrying no id A did not send.
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.url).toContain(A_INSTANCE);
    const payload = payloadOf(result.deliveries);
    expect(payload.correlated).toBe(false);
    expect("inReplyTo" in payload).toBe(false);
    expect(result.deliveries[0]?.body).not.toContain(bsSend);

    // And B's own row set is untouched.
    expect(
      await db
        .select()
        .from(emailInboundMessages)
        .where(eq(emailInboundMessages.environmentId, tenantB.environmentId)),
    ).toHaveLength(0);
  });

  it("records and drops a message for a recipient nobody receives for", async () => {
    const result = await receive({
      recipients: ["hello@reply.nobody-here.test"],
    });

    expect(result.response.status).toBe(200);
    expect(result.body.action).toBe("dropped");

    const [row] = await result.rows();
    // Kept as evidence of a provisioning gap, with no environment.
    expect(row?.environmentId).toBeNull();
    expect(row?.status).toBe("dropped");
    expect(row?.reason).toBe("unresolved_recipient");
    // No S3 read is spent on mail belonging to nobody.
    expect(result.s3Calls).toEqual([]);
    expect(result.deliveries).toEqual([]);
  });

  it("attributes by the ENVELOPE recipient even when To: names another tenant", async () => {
    // Everything the SENDER wrote points at tenant B: the `To:` header, and
    // SES's `mail.destination`, which is derived from it. The only thing
    // pointing at A is `receipt.recipients` - the SMTP envelope SES matched a
    // receipt rule on. That is the one an attacker cannot choose, so it is the
    // one that decides the tenant.
    const result = await receive({
      recipients: [`hello@reply.${A_DOMAIN}`],
      destination: [`hello@reply.${B_DOMAIN}`],
      raw: rawMessage({ to: `hello@reply.${B_DOMAIN}` }),
    });

    const [row] = await result.rows();
    expect(row?.environmentId).toBe(tenantA.environmentId);
    expect(row?.recipient).toBe(`hello@reply.${A_DOMAIN}`);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]?.url).toContain(A_INSTANCE);
    expect(result.deliveries[0]?.url).not.toContain(B_INSTANCE);
  });
});

// ---------------------------------------------------------------------------
// The loop guard
// ---------------------------------------------------------------------------

describe("auto-responders", () => {
  it("stores an Auto-Submitted message and emits NOTHING", async () => {
    const result = await receive({
      raw: rawMessage({
        subject: "Out of office",
        headers: { "Auto-Submitted": "auto-replied" },
      }),
    });

    expect(result.response.status).toBe(200);
    expect(result.body.action).toBe("suppressed");
    expect(result.body.reason).toBe("auto_submitted");

    const [row] = await result.rows();
    // STORED: the row, the reference, and the parsed facts are all there.
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("auto_submitted");
    expect(row?.subject).toBe("Out of office");
    expect(row?.objectKey).toBe(objectKeyFor(result.messageId));
    // EMITTED: nothing.
    expect(result.deliveries).toEqual([]);
  });

  it("suppresses on a parameterised Auto-Submitted value", async () => {
    const result = await receive({
      raw: rawMessage({
        headers: { "Auto-Submitted": "auto-generated; owner@example.test" },
      }),
    });
    expect(result.body.reason).toBe("auto_submitted");
    expect(result.deliveries).toEqual([]);
  });

  it("stores a Precedence: bulk message and emits NOTHING", async () => {
    const result = await receive({
      raw: rawMessage({ headers: { Precedence: "bulk" } }),
    });

    expect(result.body.action).toBe("suppressed");
    expect(result.body.reason).toBe("precedence_bulk");

    const [row] = await result.rows();
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("precedence_bulk");
    expect(result.deliveries).toEqual([]);
  });

  it("still emits for a human, who is what Auto-Submitted: no means", async () => {
    // The guard must not be a blanket "any Auto-Submitted header suppresses":
    // RFC 3834 says `no` is exactly the value a person's mail client sets.
    const result = await receive({
      raw: rawMessage({ headers: { "Auto-Submitted": "no" } }),
    });

    expect(result.body.action).toBe("delivered");
    expect(result.deliveries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The size cap
// ---------------------------------------------------------------------------

describe("an oversized message", () => {
  it("is refused without the body ever being requested", async () => {
    const result = await receive({
      // Reported by HEAD; the body in the fixture is small, so if the code ever
      // GETs anyway the assertion below catches it rather than OOMing CI.
      size: 20 * 1024 * 1024,
      deps: { maxObjectBytes: 1024 },
    });

    expect(result.response.status).toBe(200);
    expect(result.body.action).toBe("suppressed");
    expect(result.body.reason).toBe("too_large");

    // THE assertion: HEAD happened, GET never did.
    expect(result.s3Calls).toHaveLength(1);
    expect(result.s3Calls[0]).toMatch(/^head:/);

    const [row] = await result.rows();
    // Stored and referenced, so the mandatory forward (task 6) still has
    // everything it needs; only the event is skipped.
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("too_large");
    expect(row?.sizeBytes).toBe(20 * 1024 * 1024);
    expect(row?.objectKey).toBe(objectKeyFor(result.messageId));
    expect(result.deliveries).toEqual([]);
  });

  it("is refused when the body comes back bigger than HEAD claimed", async () => {
    const messageId = freshMessageId();
    const key = objectKeyFor(messageId);
    // HEAD lies (or the object changed between the two calls). The ranged GET
    // is what stops an unbounded allocation either way.
    const s3 = fakeS3(new Map([[key, { size: 10, body: rawMessage({}) }]]));
    const net = recordingFetch();

    const response = await handleSesInboundNotification(
      request(
        snsNotification(
          receivedNotification({
            messageId,
            recipients: [`hello@reply.${A_DOMAIN}`],
          }),
          { topicArn: TOPIC_ARN },
        ),
      ),
      "us",
      deps({
        fetchObject: s3.fetcher,
        fetchImpl: net.fetchImpl,
        maxObjectBytes: 16,
      }),
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.action).toBe("suppressed");
    expect(body.reason).toBe("too_large");
    expect(s3.calls).toEqual([`head:${key}`, `get:${key}`]);
    expect(net.deliveries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delivery failure
// ---------------------------------------------------------------------------

describe("instance delivery", () => {
  it("502s and keeps the row retryable when the instance is down", async () => {
    const result = await receive({
      responses: [() => new Response("nope", { status: 503 })],
    });

    expect(result.response.status).toBe(502);

    const [row] = await result.rows();
    // The message is recorded and referenced; only the hop failed.
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBeGreaterThan(0);
    expect(row?.lastError).toContain("503");
    expect(row?.objectKey).toBe(objectKeyFor(result.messageId));
  });
});
