import { createSign } from "node:crypto";
import {
  HOGSEND_RELAY_SIGNATURE_HEADER,
  verifyHogsendRelaySignature,
} from "@hogsend/plugin-hogsend";
import { eq, inArray } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  emailEvents,
  environments,
  organizations,
  sesTenants,
  stacks,
} from "../db/schema";
import { env } from "../env";
import { encryptSecretPayload } from "../lib/crypto";
import {
  handleSesEventNotification,
  type SesEventIngressDeps,
} from "../lib/email-event-ingress";
import {
  type NormalizedSesEvent,
  normalizeSesNotification,
} from "../lib/ses-events";
import {
  EMAIL_EVENT_ATTEMPTS_PER_REQUEST,
  EMAIL_EVENT_MAX_ATTEMPTS,
  EMAIL_EVENT_PENDING_CLAIM_MS,
  ingestSesEvent,
  instanceWebhookUrl,
} from "../services/email-events";
import { sesTenantName } from "../ses/names";
import {
  sesBounceNotification,
  sesComplaintNotification,
  sesDeliveryNotification,
  sesOpenNotification,
  tagForEnvironment,
  withFreshMessageId,
} from "./helpers/ses-notifications";

/**
 * THE SNS INGRESS, end to end (PRD 05 tasks 3 and 5).
 *
 * Every EARS line lands here. Nothing reaches the network: the certificate
 * fetch and the outbound instance hop are both injected.
 */

const ORG = "email-event-ingress-test-org";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-email-events-us";
const OTHER_TOPIC = "arn:aws:sns:us-east-1:999999999999:somebody-elses-topic";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotification-x.pem";
const INSTANCE_URL = "https://tenant.hogsend.app";
const WEBHOOK_SECRET = "test-webhook-secret-abcdefghijklmnop";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCoN4c2H7sLLn/m
moDGhCFJdsVEkALtFp/7X+eBvMPDjLY7Ywehp2pb7PxtlQzy4LOECGS74alu2T8l
SMTSgW9wXr4B0Uvp298NTyaH/6Iyyeyr5zO1vdTueOt5V2hvXOKlXqy8rroIduXn
VHIv3a5vNScJPTt7i/FBwnC5XfUhf3YaABclrZVdg1mlZ4yAJmLbzNeO+idUiUpG
MrzOIwDzE7e6YWg+nmnEGYqgsvQvhxUXjNG/ptvh9lKdNkAHdrRXjwNsqTlA10Bo
c2B0QM1W8vd8d1nMp+mfETbDsEv6GbkOD8nHrEZoccT4XEpRuAXr6X1WAV9a4vQR
a2ONJHMTAgMBAAECggEAQO+ml4MqPkfGAew0t+17uBNMVYpORt3MBkrgYJnQ7GUe
V9CDuqiZC0FxtI+sPvn08owW7txO/saIdMkhia2Dqlo4eRUle/JvqYCbfDZ3k6mV
XkrTEF5mm2Q8akwOuaaeq33fqrq8f9X+LA3SQp4N30oidpOXqbq8+EiqITSfEz2y
lmyEqlDk1P1oTc66et5J+KmLWmB96F2HROh1532qkcCCJe2MRhPk9pq2xqANderQ
rShzXMig5h3Q1yBG81IZNmBr5QTJBOAAmgLQ8jEByvOhgMTN2irN9QhUqDo3h90K
nWutNcmfh8n9FeMdcv4DWJEl/b5VQEd2zpJXXnRoMQKBgQDqxWrzjJO5IWcctWfi
Bkg93/zJsRarR5LyO9VbG3zKf3NwPb83NMiDEHhSxSpk/kF0VR73v9U058UzeIwO
9FmX2i7N3GDTZjDQ2WPfdDHXwV3uU5+pTGFi4VJDmOHv3SSwiXTqVTksrJ0LaS7N
tn7gbQzhT3l+iyE5l6VmmKkjqQKBgQC3bXv7fPRZBfDlPoggpkhDiIg4KjUfISfE
yOM6LHIUQWJ0C+GBAzIgB9+eOlHTLqNk/0DEKQDXGxJCW5wTL/EzHGjMKO5Jug6D
xsLkwMZbFpMZNEYcj9ohboBToDKXOjSQw+00XvZPYV9Gb9t/1+RV/WzHbUkj/Djw
cJgPBPpWWwKBgBb6B0OayIJf4IWQw3/9eWiE2Wqr6DoPITSP4ouuHwJ6gsPDZ0lx
4wXgwMXpAgMsVx+ZjRRWM/mfjU9CRwLXq0UPV3FSVi+aWsC15e5iotYo2JaQnJmn
HgjdYH25IrOlAwg8C7M7cAMNSblqK+h6KeSxB4etjYhy+Wd3jfqCilsxAoGAbmfp
A4O/s8HesK2F1FkiD/wjOeM13EnhnRHpq39LHyQH9Z+dGUFqL1tt3thtnfZphQYa
3rdreQ4jXGu1strdjI0iCxjr7Nafm/PMJVJfUj5xRe9v8AsqGYtglHVNXjc7opM7
uJUcHsWWSlhTv0ycdKG4kwUVzCIpx5eN/yRY5hcCgYAigKJeKA3yRgo2QZjyc8R1
zcZ3X8mmO3eLtR9ib5it2Y6AAje1ch6jRV6aewoGNpfPbqUFAHjagzIL/V8YoBza
giMBjzVMNBYlqrBneJXnlvHYsrXrzu7ip0LKe+4YLKn8cihe8rN9sDMKuXYiBL7a
L2oPkjuZ+RLxz037f4+8/w==
-----END PRIVATE KEY-----`;

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIULgdTvlRTvlNDIhAyKbiUUOzcsIswDQYJKoZIhvcNAQEL
BQAwOzEaMBgGA1UEAwwRc25zLmFtYXpvbmF3cy5jb20xHTAbBgNVBAoMFEhvZ3Nl
bmQgVGVzdCBGaXh0dXJlMCAXDTI2MDgxMTAwMTM0OFoYDzIxMjYwNzE4MDAxMzQ4
WjA7MRowGAYDVQQDDBFzbnMuYW1hem9uYXdzLmNvbTEdMBsGA1UECgwUSG9nc2Vu
ZCBUZXN0IEZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCo
N4c2H7sLLn/mmoDGhCFJdsVEkALtFp/7X+eBvMPDjLY7Ywehp2pb7PxtlQzy4LOE
CGS74alu2T8lSMTSgW9wXr4B0Uvp298NTyaH/6Iyyeyr5zO1vdTueOt5V2hvXOKl
Xqy8rroIduXnVHIv3a5vNScJPTt7i/FBwnC5XfUhf3YaABclrZVdg1mlZ4yAJmLb
zNeO+idUiUpGMrzOIwDzE7e6YWg+nmnEGYqgsvQvhxUXjNG/ptvh9lKdNkAHdrRX
jwNsqTlA10Boc2B0QM1W8vd8d1nMp+mfETbDsEv6GbkOD8nHrEZoccT4XEpRuAXr
6X1WAV9a4vQRa2ONJHMTAgMBAAGjUzBRMB0GA1UdDgQWBBRdRotQX1ksTPJDFFYb
HPB1/9UPJDAfBgNVHSMEGDAWgBRdRotQX1ksTPJDFFYbHPB1/9UPJDAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAEr5X9TcG2lBTBtw3IUdeTtpHP
PJEJof25VtJx6GO66Fe3kH8xnTQYCpX3t3vBctcz4QPsuUcEFh9QcDW3jHxNt1Kv
0rFz9ITzM5glbl84cL4jEgZ/qgydSOnR+K33jJTCQcGfgGiPudVadr03Kku4h0lD
+2dOc/y2ZpwNUCtCvT4HVTUaFbrXX0ZWzX9vZGwJgdNXyK6t1+ocmhR2oHd7oQRF
/2x0IlMLAmau8HL2/n6TVbz39UPLaPX1AHUjvuslBgTHNb3OjDWcqWlz6kJeeb8O
kgh3V3BG7dqVOI+wDcVQl7n2HhWMKpTFglONPHS3ip2Z+rDn0bX2c0eVp8cT
-----END CERTIFICATE-----`;

// ---------------------------------------------------------------------------
// SNS envelope helpers — the signer is written out independently of the
// implementation, so a wrong field order in `snsStringToSign` cannot sign and
// verify against itself.
// ---------------------------------------------------------------------------

function buildStringToSign(message: Record<string, string>): string {
  const fields =
    message.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : [
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ];
  return fields
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${message[field]}\n`)
    .join("");
}

let envelopeSeq = 0;

function envelope(
  fields: Record<string, string>,
  opts: { sign?: boolean } = {},
): Record<string, string> {
  envelopeSeq += 1;
  const message: Record<string, string> = {
    MessageId: `sns-message-${envelopeSeq}`,
    TopicArn: TOPIC_ARN,
    Timestamp: "2026-08-11T00:00:00.000Z",
    SignatureVersion: "1",
    SigningCertURL: CERT_URL,
    ...fields,
  };
  const signature =
    opts.sign === false
      ? "bm90LWEtc2lnbmF0dXJl"
      : createSign("RSA-SHA1")
          .update(buildStringToSign(message), "utf8")
          .sign(TEST_PRIVATE_KEY, "base64");
  return { ...message, Signature: signature };
}

function notificationOf(
  payload: unknown,
  overrides: Record<string, string> = {},
  opts: { sign?: boolean } = {},
): Record<string, string> {
  return envelope(
    { Type: "Notification", Message: JSON.stringify(payload), ...overrides },
    opts,
  );
}

function request(body: unknown): Request {
  return new Request("https://cloud.hogsend.com/api/email/events/us", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/** Every outbound instance POST this test made. */
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

function deps(
  overrides: Partial<SesEventIngressDeps> = {},
): SesEventIngressDeps {
  return {
    db,
    topicArn: TOPIC_ARN,
    fetchCertificatePem: async () => TEST_CERT_PEM,
    // No real backoff: the delay is injected so a retry test is instant.
    sleep: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;

/** An environment with a running stack and a provisioned SES tenancy. */
async function seedEnvironment(
  opts: { apiPublicUrl?: string | null } = {},
): Promise<string> {
  seq += 1;
  const [environment] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `event-env-${seq}`, kind: "test" })
    .returning();
  if (!environment) throw new Error("failed to seed environment");

  const apiPublicUrl =
    opts.apiPublicUrl === undefined ? INSTANCE_URL : opts.apiPublicUrl;
  await db.insert(stacks).values({
    organizationId: ORG,
    environmentId: environment.id,
    region: "us",
    status: "running",
    substrateRefs: apiPublicUrl
      ? { substrate: "fake", apiPublicUrl, data: {} }
      : {},
  });

  await db.insert(sesTenants).values({
    environmentId: environment.id,
    tenantName: sesTenantName(environment.id),
    tenantArn: `arn:aws:ses:us-east-1:123456789012:tenant/${sesTenantName(environment.id)}`,
    configurationSetName: sesTenantName(environment.id),
    region: "us",
    awsRegion: "us-east-1",
    webhookSecretEncrypted: encryptSecretPayload(WEBHOOK_SECRET),
    available: true,
  });

  return environment.id;
}

async function eventRows(environmentId: string) {
  return db
    .select()
    .from(emailEvents)
    .where(eq(emailEvents.environmentId, environmentId));
}

async function cleanup(): Promise<void> {
  await db.delete(emailEvents).where(eq(emailEvents.region, "us"));
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Email Event Ingress Test", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// EARS 1 — an invalid signature or a hostile SigningCertURL is a 403, with no
// certificate fetch and nothing delivered.
// ---------------------------------------------------------------------------

describe("rejection", () => {
  it("403s an unknown region without touching anything", async () => {
    const response = await handleSesEventNotification(
      request(notificationOf(withFreshMessageId(sesBounceNotification()))),
      "moon",
      deps(),
    );
    expect(response.status).toBe(404);
  });

  it("403s a message whose signature does not verify, and delivers nothing", async () => {
    const environmentId = await seedEnvironment();
    const fetchCertificatePem = vi.fn(async () => TEST_CERT_PEM);
    const { fetchImpl, deliveries } = recordingFetch();

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
          {},
          { sign: false },
        ),
      ),
      "us",
      deps({ fetchCertificatePem, fetchImpl }),
    );

    expect(response.status).toBe(403);
    expect(deliveries).toHaveLength(0);
    expect(await eventRows(environmentId)).toHaveLength(0);
  });

  it("403s a hostile SigningCertURL and NEVER fetches the certificate", async () => {
    const environmentId = await seedEnvironment();
    const fetchCertificatePem = vi.fn(async () => TEST_CERT_PEM);
    const { fetchImpl, deliveries } = recordingFetch();

    for (const hostile of [
      "https://sns.us-east-1.amazonaws.com.evil.com/x.pem",
      "https://evil.com/sns.us-east-1.amazonaws.com/x.pem",
      "https://sns.us-east-1.amazonaws.com@evil.com/x.pem",
      "http://sns.us-east-1.amazonaws.com/x.pem",
      "https://sns.us-east-1.amazonaws.co/x.pem",
      "https://sns.us-east-1.amazonaws.com/x.txt",
    ]) {
      const response = await handleSesEventNotification(
        request(
          notificationOf(
            tagForEnvironment(
              withFreshMessageId(sesBounceNotification()),
              environmentId,
            ),
            { SigningCertURL: hostile },
          ),
        ),
        "us",
        deps({ fetchCertificatePem, fetchImpl }),
      );
      expect(response.status).toBe(403);
    }

    expect(fetchCertificatePem).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
    expect(await eventRows(environmentId)).toHaveLength(0);
  });

  it("403s a message on a topic we do not own, before fetching anything", async () => {
    // "Reject any message with an unexpected TopicArn to prevent spoofing" —
    // AWS's own guidance. Checked BEFORE the certificate fetch, so a flood of
    // foreign-topic messages cannot make us fan out outbound requests.
    const fetchCertificatePem = vi.fn(async () => TEST_CERT_PEM);
    const response = await handleSesEventNotification(
      request(
        notificationOf(withFreshMessageId(sesBounceNotification()), {
          TopicArn: OTHER_TOPIC,
        }),
      ),
      "us",
      deps({ fetchCertificatePem }),
    );
    expect(response.status).toBe(403);
    expect(fetchCertificatePem).not.toHaveBeenCalled();
  });

  it("403s every message when the region has no topic configured", async () => {
    // Fail CLOSED. With no configured topic there is no such thing as a topic
    // we own, so accepting anything would accept everything.
    const response = await handleSesEventNotification(
      request(notificationOf(withFreshMessageId(sesBounceNotification()))),
      "us",
      deps({ topicArn: null }),
    );
    expect(response.status).toBe(403);
  });

  it("400s a body that is not an SNS message", async () => {
    expect(
      (
        await handleSesEventNotification(
          request({ hello: "world" }),
          "us",
          deps(),
        )
      ).status,
    ).toBe(400);

    const raw = new Request("https://cloud.hogsend.com/api/email/events/us", {
      method: "POST",
      body: "not json at all",
    });
    expect((await handleSesEventNotification(raw, "us", deps())).status).toBe(
      400,
    );
  });
});

// ---------------------------------------------------------------------------
// EARS 2 — subscription confirmation is explicit and topic-scoped
// ---------------------------------------------------------------------------

describe("subscription confirmation", () => {
  const SUBSCRIBE_URL =
    "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=t&Token=abc";

  function confirmation(overrides: Record<string, string> = {}) {
    return envelope({
      Type: "SubscriptionConfirmation",
      Message: "You have chosen to subscribe to the topic …",
      Token: "2336412f37",
      SubscribeURL: SUBSCRIBE_URL,
      ...overrides,
    });
  }

  it("confirms a subscription for a topic we own", async () => {
    const { fetchImpl, deliveries } = recordingFetch();
    const response = await handleSesEventNotification(
      request(confirmation()),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(200);
    expect(deliveries.map((d) => d.url)).toEqual([SUBSCRIBE_URL]);
  });

  it("rejects a confirmation for any other topic, and GETs nothing", async () => {
    const { fetchImpl, deliveries } = recordingFetch();
    const response = await handleSesEventNotification(
      request(confirmation({ TopicArn: OTHER_TOPIC })),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(403);
    expect(deliveries).toHaveLength(0);
  });

  it("refuses a SubscribeURL pointed off the SNS domain", async () => {
    // Blindly GETting whatever SubscribeURL arrives is the same SSRF by another
    // door — and this one arrives SIGNED, so the signature alone does not save
    // us if AWS ever signed a message naming somewhere else.
    const { fetchImpl, deliveries } = recordingFetch();
    const response = await handleSesEventNotification(
      request(
        confirmation({
          SubscribeURL: "http://169.254.169.254/latest/meta-data/",
        }),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(403);
    expect(deliveries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EARS 3-5 — normalize and deliver
// ---------------------------------------------------------------------------

describe("delivery to the instance", () => {
  it("delivers a Bounce, signed with the environment's webhook secret", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch();

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    if (!delivery) throw new Error("expected one delivery");

    expect(delivery.url).toBe(instanceWebhookUrl(INSTANCE_URL));
    expect(delivery.url).toBe(`${INSTANCE_URL}/v1/webhooks/email/hogsend`);

    // THE interop assertion: the plugin's own verifier accepts what we signed,
    // over the EXACT bytes we posted. A mismatch here would mean every event is
    // silently rejected at the instance and bounce handling quietly does
    // nothing.
    expect(
      verifyHogsendRelaySignature({
        payload: delivery.body,
        secret: WEBHOOK_SECRET,
        signature: delivery.signature,
      }),
    ).toBe(true);

    const sent = JSON.parse(delivery.body);
    expect(sent.type).toBe("email.bounced");
    expect(sent.bounce.type).toBe("Permanent");
    // The timestamp is INSIDE the signed body, so it cannot be moved without
    // breaking the signature.
    expect(sent.occurredAt).toBe("2017-08-05T00:41:02.669Z");

    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(1);
    expect(row?.tenantName).toBe(sesTenantName(environmentId));
  });

  it("delivers a Complaint and a Delivery", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch();

    for (const payload of [
      withFreshMessageId(sesComplaintNotification()),
      withFreshMessageId(sesDeliveryNotification()),
    ]) {
      const response = await handleSesEventNotification(
        request(notificationOf(tagForEnvironment(payload, environmentId))),
        "us",
        deps({ fetchImpl }),
      );
      expect(response.status).toBe(200);
    }

    expect(deliveries.map((d) => JSON.parse(d.body).type)).toEqual([
      "email.complained",
      "email.delivered",
    ]);
  });

  it("acknowledges an Open without recording or delivering anything", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch();

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesOpenNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    // 200, not an error: a configuration set publishing an event type we do not
    // consume is a provisioning bug to fix, not a reason to make SNS retry
    // forever.
    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(0);
    expect(await eventRows(environmentId)).toHaveLength(0);
  });

  it("collapses an at-least-once redelivery to ONE instance delivery", async () => {
    // SNS delivers at least once, and the engine's `handleWebhook` has no
    // dedupe: it re-emits outbound events and increments the bounce counter
    // toward the suppression threshold every time. A duplicate therefore
    // suppresses deliverable addresses, so the collapse has to happen here.
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch();
    const payload = tagForEnvironment(
      withFreshMessageId(sesBounceNotification()),
      environmentId,
    );

    // Two DIFFERENT SNS envelopes carrying the SAME SES event — which is what a
    // redelivery actually looks like, since the envelope id changes per publish.
    for (let i = 0; i < 3; i += 1) {
      const response = await handleSesEventNotification(
        request(notificationOf(payload)),
        "us",
        deps({ fetchImpl }),
      );
      expect(response.status).toBe(200);
    }

    expect(deliveries).toHaveLength(1);
    expect(await eventRows(environmentId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// EARS 6 — an unresolvable tenant is recorded and dropped, never broadcast
// ---------------------------------------------------------------------------

describe("unresolved tenant", () => {
  it("records the unresolved tenant name and delivers to nobody", async () => {
    // Broadcasting would let one tenant's bounce suppress another tenant's
    // contact, which is the cross-tenant leak this whole stack is built to
    // avoid.
    await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch();

    const payload = tagForEnvironment(
      sesBounceNotification(),
      "99999999-9999-4999-8999-999999999999",
    );
    const response = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(0);

    const [row] = await db
      .select()
      .from(emailEvents)
      .where(
        eq(emailEvents.tenantName, "env-99999999-9999-4999-8999-999999999999"),
      );
    expect(row?.status).toBe("dropped");
    expect(row?.environmentId).toBeNull();
    expect(row?.lastError).toContain("tenant");
  });

  it("records an event whose notification names no tenant at all", async () => {
    const { fetchImpl, deliveries } = recordingFetch();
    const payload = withFreshMessageId(sesComplaintNotification());
    (payload.mail as Record<string, unknown>).tags = {};
    const messageId = (payload.mail as Record<string, unknown>)
      .messageId as string;

    const response = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(0);
    const [row] = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.messageId, messageId));
    expect(row?.status).toBe("dropped");
    expect(row?.tenantName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EARS 8 — bounded retry, then a recorded terminal failure
// ---------------------------------------------------------------------------

describe("bounded retry", () => {
  it("retries a 5xx within one request and succeeds", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch([
      new Response("boom", { status: 503 }),
      new Response("boom", { status: 503 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(200);
    expect(deliveries).toHaveLength(3);
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("delivered");
    expect(row?.attempts).toBe(3);
  });

  it("stops at the per-request attempt bound and records the failure", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch([
      new Response("boom", { status: 503 }),
    ]);

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(deliveries).toHaveLength(EMAIL_EVENT_ATTEMPTS_PER_REQUEST);
    // 502 so SNS re-drives — its own retry policy is the durable one, and the
    // row's attempt ceiling is what stops it being forever.
    expect(response.status).toBe(502);

    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(EMAIL_EVENT_ATTEMPTS_PER_REQUEST);
    expect(row?.lastError).toContain("503");
  });

  it("does NOT retry a 4xx — a refusal is not a blip", async () => {
    // A 401 means the instance rejected our signature. Retrying it hammers a
    // tenant with requests it will refuse identically every time.
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch([
      new Response("nope", { status: 401 }),
    ]);

    await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(deliveries).toHaveLength(1);
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
  });

  it("retries a 429, which is a blip", async () => {
    const environmentId = await seedEnvironment();
    const { fetchImpl, deliveries } = recordingFetch([
      new Response("slow down", { status: 429 }),
    ]);

    await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(deliveries).toHaveLength(EMAIL_EVENT_ATTEMPTS_PER_REQUEST);
  });

  it("stops re-driving once the row hits the hard attempt ceiling", async () => {
    // NEVER retries forever. SNS keeps re-delivering for days; the ceiling on
    // the row is what turns that into a terminal state.
    const environmentId = await seedEnvironment();
    const { fetchImpl } = recordingFetch([
      new Response("boom", { status: 503 }),
    ]);
    const payload = tagForEnvironment(
      withFreshMessageId(sesBounceNotification()),
      environmentId,
    );

    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) {
      const response = await handleSesEventNotification(
        request(notificationOf(payload)),
        "us",
        deps({ fetchImpl }),
      );
      lastStatus = response.status;
    }

    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(EMAIL_EVENT_MAX_ATTEMPTS);
    // 200 once it is terminal: asking SNS to keep retrying something we have
    // stopped attempting would be a lie.
    expect(lastStatus).toBe(200);
  });

  it("retries when the instance has no URL yet, rather than dropping the event", async () => {
    // A stack mid-provision has no `apiPublicUrl`. That is transient, and a
    // dropped bounce is permanent, so it must not be a drop.
    const environmentId = await seedEnvironment({ apiPublicUrl: null });
    const { fetchImpl, deliveries } = recordingFetch();

    const response = await handleSesEventNotification(
      request(
        notificationOf(
          tagForEnvironment(
            withFreshMessageId(sesBounceNotification()),
            environmentId,
          ),
        ),
      ),
      "us",
      deps({ fetchImpl }),
    );

    expect(response.status).toBe(502);
    expect(deliveries).toHaveLength(0);
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("failed");
    expect(row?.environmentId).toBe(environmentId);
  });
});

// ---------------------------------------------------------------------------
// An abandoned `pending` row — the process died between the insert and settle
// ---------------------------------------------------------------------------

describe("pending recovery", () => {
  /** The event exactly as the ingress hands it to the service. */
  function normalizedBounce(environmentId: string): NormalizedSesEvent {
    const normalized = normalizeSesNotification(
      tagForEnvironment(
        withFreshMessageId(sesBounceNotification()),
        environmentId,
      ),
    );
    if (!normalized) throw new Error("the bounce fixture did not normalize");
    return normalized;
  }

  /**
   * Kill the process mid-delivery: the row is inserted, the first POST fails,
   * and the injected sleep — the seam BETWEEN attempts — throws, so control
   * never reaches `settle` and the row is left `pending`. This is what a
   * redeploy, an OOM or SNS timing the request out actually leaves behind.
   */
  async function crashMidDelivery(normalized: NormalizedSesEvent) {
    const unreachable = (async () => {
      throw new Error("connect ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      ingestSesEvent(
        { region: "us", normalized },
        {
          db,
          fetchImpl: unreachable,
          sleep: async () => {
            throw new Error("process died before settle");
          },
        },
      ),
    ).rejects.toThrow("process died before settle");
  }

  /** A clock past the claim window, with slack for DB-vs-JS clock slop. */
  function afterClaimWindow(): Date {
    return new Date(Date.now() + EMAIL_EVENT_PENDING_CLAIM_MS + 60_000);
  }

  it("recovers a pending row the process abandoned, and delivers the bounce", async () => {
    const environmentId = await seedEnvironment();
    const normalized = normalizedBounce(environmentId);

    await crashMidDelivery(normalized);
    const [abandoned] = await eventRows(environmentId);
    expect(abandoned?.status).toBe("pending");

    // SNS redelivers — it re-drives for hours, which is the whole reason the
    // dedupe exists. A lost bounce is a suppression that never happens.
    const { fetchImpl, deliveries } = recordingFetch();
    const outcome = await ingestSesEvent(
      { region: "us", normalized },
      { db, fetchImpl, sleep: async () => {}, now: afterClaimWindow() },
    );

    expect(outcome.status).toBe("delivered");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.url).toBe(instanceWebhookUrl(INSTANCE_URL));
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("delivered");
  });

  it("does NOT recover a pending row that is at the wire right now", async () => {
    // SNS can hand the same notification to two of our instances at once. A
    // YOUNG pending row means a concurrent request is mid-flight, and
    // recovering it would turn one bounce into two deliveries.
    const environmentId = await seedEnvironment();
    const normalized = normalizedBounce(environmentId);

    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let atTheWire!: () => void;
    const wireReached = new Promise<void>((resolve) => {
      atTheWire = resolve;
    });
    let holds = 0;
    const gated = (async () => {
      holds += 1;
      atTheWire();
      return gate;
    }) as unknown as typeof fetch;

    const first = ingestSesEvent(
      { region: "us", normalized },
      { db, fetchImpl: gated, sleep: async () => {} },
    );
    await wireReached;

    const { fetchImpl, deliveries } = recordingFetch();
    const second = await ingestSesEvent(
      { region: "us", normalized },
      { db, fetchImpl, sleep: async () => {} },
    );
    // `in_flight`, not `duplicate`: no second delivery, but the answer is
    // TEMPORARY — the ingress maps it to a non-2xx so SNS comes back.
    expect(second.status).toBe("in_flight");
    expect(deliveries).toHaveLength(0);

    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect((await first).status).toBe("delivered");
    expect(holds).toBe(1);
  });

  it("lets exactly ONE of two concurrent re-drives claim an abandoned row", async () => {
    // Both redeliveries find the same stale row; the conditional UPDATE is
    // what serialises them. Exactly one may reach the wire.
    const environmentId = await seedEnvironment();
    const normalized = normalizedBounce(environmentId);
    await crashMidDelivery(normalized);

    const { fetchImpl, deliveries } = recordingFetch();
    const now = afterClaimWindow();
    const outcomes = await Promise.all([
      ingestSesEvent(
        { region: "us", normalized },
        { db, fetchImpl, sleep: async () => {}, now },
      ),
      ingestSesEvent(
        { region: "us", normalized },
        { db, fetchImpl, sleep: async () => {}, now },
      ),
    ]);

    // Exactly one winner. The loser's answer depends on when it looked:
    // `in_flight` if it lost the claim race (temporary — the ingress non-2xx
    // brings SNS back to find the settled row), or `duplicate` if it read the
    // row after the winner had already settled it. Both are correct; what may
    // never happen is a second delivery.
    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses[0]).toBe("delivered");
    expect(["duplicate", "in_flight"]).toContain(statuses[1]);
    expect(deliveries).toHaveLength(1);
  });

  it("answers an early redelivery with a retry-inviting non-2xx, then recovers on the one it invited", async () => {
    // THE REAL SNS TIMELINE. The crash leaves the row `pending`; SNS got no
    // response, so it retries within seconds — well INSIDE the claim window.
    // A 200 on that retry would mark the notification delivered and stop SNS
    // forever: the window could then never elapse for anybody, the row would
    // stay `pending` until the end of time, and the bounce would be lost.
    // So "seen, unsettled, not claimable yet" must be a NON-2xx — a temporary
    // answer that keeps SNS's own retry schedule (the durable one) alive.
    const environmentId = await seedEnvironment();
    const payload = tagForEnvironment(
      withFreshMessageId(sesBounceNotification()),
      environmentId,
    );

    // T0: the process dies mid-delivery — insert done, settle never reached.
    const unreachable = (async () => {
      throw new Error("connect ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      handleSesEventNotification(
        request(notificationOf(payload)),
        "us",
        deps({
          fetchImpl: unreachable,
          sleep: async () => {
            throw new Error("process died before settle");
          },
        }),
      ),
    ).rejects.toThrow("process died before settle");

    // T0 + seconds: SNS's early retry. Must invite another, deliver nothing.
    const early = recordingFetch();
    const earlyResponse = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl: early.fetchImpl }),
    );
    expect(earlyResponse.status).toBe(503);
    expect(early.deliveries).toHaveLength(0);

    // The retry the 503 invited, now past the window: claims and delivers.
    const late = recordingFetch();
    const lateResponse = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl: late.fetchImpl, now: afterClaimWindow() }),
    );
    expect(lateResponse.status).toBe(200);
    expect(late.deliveries).toHaveLength(1);
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("delivered");
  });

  it("still answers a SETTLED duplicate 200, so SNS stops", async () => {
    // The counterpart guard: once the row is terminal, a non-2xx would make
    // SNS re-drive a duplicate for days. (The at-least-once collapse test
    // above pins the same thing across three drives.)
    const environmentId = await seedEnvironment();
    const payload = tagForEnvironment(
      withFreshMessageId(sesBounceNotification()),
      environmentId,
    );
    const { fetchImpl } = recordingFetch();

    const first = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl }),
    );
    expect(first.status).toBe(200);

    const redelivery = await handleSesEventNotification(
      request(notificationOf(payload)),
      "us",
      deps({ fetchImpl }),
    );
    expect(redelivery.status).toBe(200);
    expect(((await redelivery.json()) as Record<string, unknown>).action).toBe(
      "duplicate",
    );
  });

  it("never recovers past the attempt ceiling, and makes the abandonment terminal", async () => {
    const environmentId = await seedEnvironment();
    const normalized = normalizedBounce(environmentId);
    await crashMidDelivery(normalized);

    // A crash loop burned every attempt and the last claimant also died,
    // leaving the row `pending` at the ceiling. Written directly: driving
    // nine real crash-claims would only re-prove the path the tests above own.
    await db
      .update(emailEvents)
      .set({ attempts: EMAIL_EVENT_MAX_ATTEMPTS })
      .where(eq(emailEvents.dedupeKey, normalized.dedupeKey));

    const { fetchImpl, deliveries } = recordingFetch();
    const outcome = await ingestSesEvent(
      { region: "us", normalized },
      { db, fetchImpl, sleep: async () => {}, now: afterClaimWindow() },
    );

    expect(outcome.status).toBe("duplicate");
    expect(deliveries).toHaveLength(0);
    // And not parked `pending` forever: the exhausted abandonment is made
    // terminal so the status index (the operator read) can find it.
    const [row] = await eventRows(environmentId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("abandoned");
  });
});
