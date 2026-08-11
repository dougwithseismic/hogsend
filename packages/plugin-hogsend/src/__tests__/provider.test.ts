import type { SendEmailOptions } from "@hogsend/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  createHogsendEmailProvider,
  HOGSEND_IDEMPOTENCY_HEADER,
  HogsendRelayBatchError,
  HogsendRelayError,
  HogsendRelayPausedError,
} from "../index.js";

// ---------------------------------------------------------------------------
// A stubbed relay. Every test drives the wire through this — nothing here ever
// touches the network, and every assertion is on the exact bytes we would have
// put on it.
// ---------------------------------------------------------------------------

interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body, for the "the relay answered with HTML" case. */
  text?: string;
}

interface RelayCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    message?: Record<string, unknown>;
    items?: Array<{ idempotencyKey: string; message: Record<string, unknown> }>;
  };
  rawBody: string;
}

function stubRelay(...responses: StubResponse[]) {
  const calls: RelayCall[] = [];
  const queue = [...responses];

  const impl = vi.fn(
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const rawBody = String(init?.body ?? "");
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>).map(
            ([k, v]) => [k.toLowerCase(), v],
          ),
        ),
        body: rawBody ? JSON.parse(rawBody) : {},
        rawBody,
      });

      const next = queue.shift() ?? {
        status: 200,
        body: { id: "ses_default" },
      };
      return new Response(next.text ?? JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: {
          "content-type": next.text ? "text/html" : "application/json",
          ...next.headers,
        },
      });
    },
  );

  return { fetch: impl as unknown as typeof fetch, calls, impl };
}

const CONFIG = {
  relayUrl: "https://cloud.hogsend.com",
  tenantToken: "hsrel_tenant_token",
};

const MESSAGE: SendEmailOptions = {
  from: "hello@hogsend.com",
  to: "user@example.com",
  subject: "Hello",
  html: "<p>hi</p>",
};

let warn: Mock<(message: string) => void>;

beforeEach(() => {
  warn = vi.fn<(message: string) => void>();
});

describe("identity + capabilities", () => {
  const provider = createHogsendEmailProvider(CONFIG);

  it("is the `hogsend` provider", () => {
    expect(provider.meta).toEqual({
      id: "hogsend",
      name: "Hogsend Email",
      description: expect.any(String),
    });
  });

  it("declares DECISIONS §3.6 capabilities", () => {
    expect(provider.capabilities).toEqual({
      nativeTracking: false,
      scheduledSend: false,
      attachments: true,
      signedWebhooks: true,
      consumesIdempotencyKey: true,
    });
  });

  it("DECLARES `attachments` — the flag is load-bearing consent", () => {
    // The engine refuses to hand attachments to a provider that has not
    // declared it can carry them: an absent flag means a send WITH files
    // fails loudly instead of delivering the message without them (a receipt
    // minus its invoice looks sent from every dashboard). Dropping this line
    // turns every attachment send through this provider into that loud
    // failure.
    expect(provider.capabilities?.attachments).toBe(true);
  });

  it("DECLARES `consumesIdempotencyKey` — the engine reads only the flag", () => {
    // This is what makes the engine thread its replay-stable key onto this
    // wire, and it is safe ONLY because `send`/`sendBatch` lift the header off
    // `options.headers` onto the relay REQUEST (see `toRelayMessage`), so it
    // never reaches the delivered message. Dropping this line silently disables
    // replay protection: the relay would fall back to hashing message bytes,
    // which change on every attempt because `prepareTrackedHtml` mints fresh
    // link ids — so a journey replayed after a worker crash sends twice.
    expect(provider.capabilities?.consumesIdempotencyKey).toBe(true);
  });

  it("HAS a `domains` member — presence is the gate PRD 07 opened", () => {
    // Dropping it silently reports `supported: false` on the engine's admin
    // domain routes, `hogsend domain` and Studio Setup, with no error anywhere.
    // The capability's own behaviour is covered in `domains.test.ts`.
    expect(provider.domains).toBeDefined();
    expect("domains" in provider).toBe(true);
  });
});

describe("send → POST /api/email/send", () => {
  it("posts the message to the relay and returns its id unchanged", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const result = await provider.send({
      from: "hello@hogsend.com",
      to: ["a@example.com", "b@example.com"],
      cc: "cc@example.com",
      bcc: ["bcc@example.com"],
      replyTo: "reply@hogsend.com",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      tags: [{ name: "template", value: "welcome" }],
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
    });

    expect(result).toEqual({ id: "ses_msg_1" });
    expect(relay.calls).toHaveLength(1);
    const call = relay.calls[0];
    expect(call?.url).toBe("https://cloud.hogsend.com/api/email/send");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer hsrel_tenant_token");
    expect(call?.headers["content-type"]).toBe("application/json");
    // The relay's message schema is STRICT: every recipient field is an array.
    expect(call?.body.message).toEqual({
      from: "hello@hogsend.com",
      to: ["a@example.com", "b@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      replyTo: ["reply@hogsend.com"],
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      tags: [{ name: "template", value: "welcome" }],
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
    });
  });

  it("omits absent optional fields rather than sending empty arrays", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);

    const message = relay.calls[0]?.body.message ?? {};
    expect(Object.keys(message).sort()).toEqual([
      "from",
      "html",
      "subject",
      "to",
    ]);
    expect(message.to).toEqual(["user@example.com"]);
  });

  it("normalizes a relayUrl with a trailing slash", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      relayUrl: "https://cloud.hogsend.com///",
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);

    expect(relay.calls[0]?.url).toBe(
      "https://cloud.hogsend.com/api/email/send",
    );
  });

  it("throws when the relay answers 200 with no id", async () => {
    const relay = stubRelay({ body: { ok: true } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await expect(provider.send(MESSAGE)).rejects.toThrow(HogsendRelayError);
  });
});

describe("HTML-only wire", () => {
  it("never lets a React value reach the wire", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    // A caller that smuggles React (or anything else) onto the options object:
    // the body is CONSTRUCTED field by field, never spread, so it cannot ride
    // along. The relay's own schema is strict and would 400 it anyway.
    await provider.send({
      ...MESSAGE,
      react: { $$typeof: Symbol.for("react.element"), type: "div" },
      template: "welcome",
    } as unknown as SendEmailOptions);

    const call = relay.calls[0];
    expect(call?.body.message).not.toHaveProperty("react");
    expect(call?.body.message).not.toHaveProperty("template");
    expect(call?.rawBody).not.toContain("react");
    expect(call?.body.message?.html).toBe("<p>hi</p>");
  });
});

describe("attachments on the wire", () => {
  it("pins the wire attachment shape FIELD BY FIELD — the relay is a hand-synced twin", async () => {
    // `apps/cloud/src/lib/email-attachments.ts` (`WireEmailAttachment`) is the
    // counterpart this shape must move with. plugin-hogsend and apps/cloud
    // are separate packages with NO compile-time link — nothing but this test
    // and the relay's strict zod schema holds the two shapes together, which
    // is why every key and every type is pinned here exactly rather than
    // matched loosely. A drift the relay tolerates would otherwise ship
    // unnoticed until its schema tightens.
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      attachments: [
        {
          filename: "invoice.pdf",
          content: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
          disposition: "inline",
          contentId: "inv-1",
        },
      ],
    });

    const posted = (
      relay.calls[0]?.body.message?.attachments as Array<
        Record<string, unknown>
      >
    )[0];
    expect(posted).toBeDefined();
    // Exact keys — nothing extra rides along, nothing is renamed.
    expect(Object.keys(posted ?? {}).sort()).toEqual([
      "content",
      "contentId",
      "contentType",
      "disposition",
      "filename",
    ]);
    // Exact types + values: content is a base64 STRING, always — JSON cannot
    // carry raw bytes, so the wire has no bytes-vs-base64 discriminant.
    expect(posted).toEqual({
      filename: "invoice.pdf",
      content: "AQID",
      contentType: "application/pdf",
      disposition: "inline",
      contentId: "inv-1",
    });
    expect(typeof posted?.content).toBe("string");
  });

  it("posts a Uint8Array attachment as its base64 encoding", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      attachments: [
        {
          filename: "hello.txt",
          // "hello" as bytes → "aGVsbG8=" on the wire.
          content: new Uint8Array([104, 101, 108, 108, 111]),
        },
      ],
    });

    const posted = (
      relay.calls[0]?.body.message?.attachments as Array<
        Record<string, unknown>
      >
    )[0];
    expect(posted).toEqual({ filename: "hello.txt", content: "aGVsbG8=" });
  });

  it("passes a { base64 } attachment through VERBATIM, never re-encoded", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });
    // Unpadded on purpose: a decode → re-encode round-trip would come back
    // padded ("aGVsbG8gd29ybGQ="), so byte equality here proves the string
    // was never touched. The round-trip is not just wasted work on what can
    // be a ~33 MB string — `Buffer.from(s, "base64")` silently drops
    // characters it does not recognise, so re-encoding would launder invalid
    // content into plausible bytes the relay's validity check can no longer
    // refuse.
    const unpadded = "aGVsbG8gd29ybGQ";

    await provider.send({
      ...MESSAGE,
      attachments: [{ filename: "hello.txt", content: { base64: unpadded } }],
    });

    const posted = (
      relay.calls[0]?.body.message?.attachments as Array<
        Record<string, unknown>
      >
    )[0];
    expect(posted?.content).toBe(unpadded);
  });

  it("omits absent optional attachment fields rather than sending undefined", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      attachments: [{ filename: "a.bin", content: new Uint8Array([1]) }],
    });

    const posted = (
      relay.calls[0]?.body.message?.attachments as Array<
        Record<string, unknown>
      >
    )[0];
    expect(Object.keys(posted ?? {}).sort()).toEqual(["content", "filename"]);
  });

  it("sends NO attachments key when there are none — absent or []", async () => {
    // The attachment-free request body must stay byte-identical to what it
    // was before attachments existed; an empty array must not become a
    // schema-visible `"attachments":[]` on the wire.
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_2" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);
    await provider.send({ ...MESSAGE, attachments: [] });

    for (const call of relay.calls) {
      expect(call.body.message).not.toHaveProperty("attachments");
      expect(call.rawBody).not.toContain("attachments");
    }
  });

  it("sendBatch carries each item's OWN attachments", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          { status: "sent", id: "ses_b" },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.sendBatch([
      {
        from: "f@h.com",
        to: "a@example.com",
        subject: "s",
        html: "<p>a</p>",
        attachments: [
          { filename: "a.txt", content: new Uint8Array([104, 105]) },
        ],
      },
      { from: "f@h.com", to: "b@example.com", subject: "s", html: "<p>b</p>" },
    ]);

    const items = relay.calls[0]?.body.items ?? [];
    expect(items[0]?.message.attachments).toEqual([
      { filename: "a.txt", content: "aGk=" },
    ]);
    // The attachment-free item stays attachment-free — no cross-item bleed.
    expect(items[1]?.message).not.toHaveProperty("attachments");
  });

  it("a caller-supplied Idempotency-Key still wins, verbatim, with attachments present", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      headers: { "Idempotency-Key": "journeySend:run_9:invoice" },
      attachments: [
        { filename: "invoice.pdf", content: new Uint8Array([1, 2, 3]) },
      ],
    });

    const call = relay.calls[0];
    expect(call?.headers[HOGSEND_IDEMPOTENCY_HEADER]).toBe(
      "journeySend:run_9:invoice",
    );
    // Still transport metadata, never a delivered SMTP header.
    expect(call?.body.message).not.toHaveProperty("headers");
  });
});

describe("idempotency key", () => {
  it("forwards a caller-supplied key as the Idempotency-Key header", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      headers: { "Idempotency-Key": "journeySend:run_1:welcome" },
    });

    const call = relay.calls[0];
    expect(call?.headers[HOGSEND_IDEMPOTENCY_HEADER]).toBe(
      "journeySend:run_1:welcome",
    );
    // Transport metadata, not a message header — it must NOT be delivered as
    // an SMTP header on the customer's mail.
    expect(call?.body.message).not.toHaveProperty("headers");
  });

  it("reads the caller's key case-insensitively", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      headers: { "idempotency-key": "k_1", "X-Keep": "yes" },
    });

    const call = relay.calls[0];
    expect(call?.headers[HOGSEND_IDEMPOTENCY_HEADER]).toBe("k_1");
    expect(call?.body.message?.headers).toEqual({ "X-Keep": "yes" });
  });

  it("ALWAYS sends a key — the relay 400s without one", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);

    const key = relay.calls[0]?.headers[HOGSEND_IDEMPOTENCY_HEADER];
    expect(key).toBeTruthy();
    expect((key ?? "").length).toBeLessThanOrEqual(255);
  });

  it("passes a long caller key VERBATIM rather than truncating it", async () => {
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });
    // Over the relay's 255-character cap. Truncating would risk two distinct
    // keys collapsing to one — the relay would call the second a replay and
    // silently never send it. Its loud 400 is the correct outcome instead.
    const long = `k_${"x".repeat(300)}`;

    await provider.send({ ...MESSAGE, headers: { "Idempotency-Key": long } });

    expect(relay.calls[0]?.headers[HOGSEND_IDEMPOTENCY_HEADER]).toBe(long);
  });

  it("derives the fallback key from content, so a replay dedupes", async () => {
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_2" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);
    await provider.send(MESSAGE);
    await provider.send({ ...MESSAGE, subject: "Different" });

    const keys = relay.calls.map(
      (c) => c.headers[HOGSEND_IDEMPOTENCY_HEADER] ?? "",
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("derives the EXACT key it always has for a no-attachment message", async () => {
    // Hardcoded on purpose. The derived key is a LIVE dedup key — the relay
    // remembers it for 7 days — so a release that shifts its value for the
    // same bytes silently changes every existing customer's replay behaviour:
    // an in-window replay stops deduping and sends twice. The attachment work
    // rebuilt `derivedIdempotencyKey` around a digest projection; this pin is
    // what proves a message with no attachments still hashes the message
    // object itself, byte for byte. If this test fails, the fix is in the
    // provider, not here.
    const relay = stubRelay({ body: { id: "ses_msg_1" } });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);

    expect(relay.calls[0]?.headers[HOGSEND_IDEMPOTENCY_HEADER]).toBe(
      "hs_auto_31bb79af6780405189db4dd3a8ff033e6e6ec45660f4622da2c97289d8e1fdd3",
    );
  });

  it("derives the same key for a replay carrying the same attachment bytes", async () => {
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_1" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });
    const attached = () => ({
      ...MESSAGE,
      attachments: [
        { filename: "report.bin", content: new Uint8Array([1, 2, 3, 4]) },
      ],
    });

    await provider.send(attached());
    await provider.send(attached());

    const keys = relay.calls.map(
      (c) => c.headers[HOGSEND_IDEMPOTENCY_HEADER] ?? "",
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("derives DIFFERENT keys for different bytes behind the same filename and size", async () => {
    // THE anti-collision assertion — written deliberately. A key derived from
    // filename + size alone would make these two sends ONE: the relay would
    // answer the second with the first's id and never deliver it, silently.
    // The key's projection digests the attachment CONTENT, so two files that
    // agree on every visible property still diverge.
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_2" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send({
      ...MESSAGE,
      attachments: [
        { filename: "report.bin", content: new Uint8Array([1, 2, 3, 4]) },
      ],
    });
    await provider.send({
      ...MESSAGE,
      attachments: [
        { filename: "report.bin", content: new Uint8Array([4, 3, 2, 1]) },
      ],
    });

    const keys = relay.calls.map(
      (c) => c.headers[HOGSEND_IDEMPOTENCY_HEADER] ?? "",
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("differs from the no-attachment key when an attachment is present", async () => {
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_2" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.send(MESSAGE);
    await provider.send({
      ...MESSAGE,
      attachments: [{ filename: "a.txt", content: new Uint8Array([104]) }],
    });

    const keys = relay.calls.map(
      (c) => c.headers[HOGSEND_IDEMPOTENCY_HEADER] ?? "",
    );
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("scheduledAt (unsupported capability)", () => {
  it("logs ONCE, points at ctx.sleepUntil, and sends immediately", async () => {
    const relay = stubRelay(
      { body: { id: "ses_msg_1" } },
      { body: { id: "ses_msg_2" } },
    );
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
      logger: { warn },
    });

    const first = await provider.send({
      ...MESSAGE,
      scheduledAt: "2030-01-01T00:00:00Z",
    });
    const second = await provider.send({
      ...MESSAGE,
      subject: "Second",
      scheduledAt: "2030-01-02T00:00:00Z",
    });

    // Sent immediately — never failed, never queued.
    expect(first).toEqual({ id: "ses_msg_1" });
    expect(second).toEqual({ id: "ses_msg_2" });
    expect(relay.calls).toHaveLength(2);
    // Dropped from the wire: the relay's schema is strict and Hogsend Email has
    // no scheduled send.
    expect(relay.calls[0]?.body.message).not.toHaveProperty("scheduledAt");
    // ONE warning for the life of the provider, naming the better answer.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("ctx.sleepUntil");
  });
});

describe("relay errors — typed, and NEVER retried", () => {
  it("403 tenant_paused → typed error carrying reason + pausedAt", async () => {
    const relay = stubRelay({
      status: 403,
      body: {
        error: "tenant_paused",
        message: "This environment's email sending is paused.",
        reason: "SES paused this tenant: complaint rate above 0.1%",
        pausedAt: "2026-08-10T09:30:00.000Z",
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = await provider.send(MESSAGE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HogsendRelayPausedError);
    expect(error).toBeInstanceOf(HogsendRelayError);
    const paused = error as HogsendRelayPausedError;
    expect(paused.status).toBe(403);
    expect(paused.error).toBe("tenant_paused");
    expect(paused.reason).toBe(
      "SES paused this tenant: complaint rate above 0.1%",
    );
    expect(paused.pausedAt).toBe("2026-08-10T09:30:00.000Z");
    expect(paused.retryable).toBe(false);
    // The reason has to survive to the journey, so it is in the message too.
    expect(paused.message).toContain("complaint rate above 0.1%");
    // NEVER retried. One request, exactly.
    expect(relay.calls).toHaveLength(1);
  });

  it("keeps a null pausedAt/reason null rather than inventing one", async () => {
    const relay = stubRelay({
      status: 403,
      body: {
        error: "tenant_paused",
        message: "paused",
        reason: null,
        pausedAt: null,
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayPausedError;

    expect(error.reason).toBeNull();
    expect(error.pausedAt).toBeNull();
  });

  const fourXX: Array<[number, string]> = [
    [400, "invalid_request"],
    [400, "send_rejected"],
    [401, "missing_token"],
    [401, "invalid_token"],
    [402, "email_allowance_exhausted"],
    [413, "payload_too_large"],
  ];

  for (const [status, slug] of fourXX) {
    it(`${status} ${slug} → typed, not retryable, ONE request`, async () => {
      const relay = stubRelay({
        status,
        body: { error: slug, message: "nope" },
      });
      const provider = createHogsendEmailProvider({
        ...CONFIG,
        fetch: relay.fetch,
      });

      const error = (await provider
        .send(MESSAGE)
        .catch((e: unknown) => e)) as HogsendRelayError;

      expect(error).toBeInstanceOf(HogsendRelayError);
      expect(error.status).toBe(status);
      expect(error.error).toBe(slug);
      expect(error.retryable).toBe(false);
      expect(relay.calls).toHaveLength(1);
    });
  }

  it("409 send_in_progress → typed, advisory-retryable, still ONE request", async () => {
    const relay = stubRelay({
      status: 409,
      body: {
        error: "send_in_progress",
        message: "An identical send is at the wire right now.",
      },
      headers: { "retry-after": "1" },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayError;

    expect(error).toBeInstanceOf(HogsendRelayError);
    expect(error.status).toBe(409);
    expect(error.error).toBe("send_in_progress");
    // The relay itself invites the retry (its twin at the wire holds the id).
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(1);
    // But this wire NEVER retries — the durable task layer owns that.
    expect(relay.calls).toHaveLength(1);
  });

  it("429 rate_limited → retryable, carries Retry-After, still ONE request", async () => {
    const relay = stubRelay({
      status: 429,
      body: { error: "rate_limited", message: "slow down" },
      headers: { "retry-after": "37" },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayError;

    expect(error.error).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(37);
    // Retryable is ADVISORY — the durable task layer owns retry, not the wire.
    expect(relay.calls).toHaveLength(1);
  });

  it("503 send_unavailable → retryable, ONE request", async () => {
    const relay = stubRelay({
      status: 503,
      body: { error: "send_unavailable", message: "SES unavailable" },
      headers: { "retry-after": "5" },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayError;

    expect(error.error).toBe("send_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(5);
    expect(relay.calls).toHaveLength(1);
  });

  it("carries the whole error body for anything the caller wants to read", async () => {
    const relay = stubRelay({
      status: 402,
      body: {
        error: "email_allowance_exhausted",
        message: "used up",
        limit: 10_000,
        used: 10_000,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayError;

    expect(error.body).toMatchObject({ limit: 10_000, used: 10_000 });
  });

  it("survives a non-JSON error body", async () => {
    const relay = stubRelay({ status: 502, text: "<html>bad gateway</html>" });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .send(MESSAGE)
      .catch((e: unknown) => e)) as HogsendRelayError;

    expect(error).toBeInstanceOf(HogsendRelayError);
    expect(error.status).toBe(502);
    expect(error.error).toBe("send_failed");
    expect(error.retryable).toBe(true);
  });
});

describe("sendBatch → POST /api/email/send-batch", () => {
  it("posts items and returns one result per input item IN ORDER", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          { status: "sent", id: "ses_b", idempotent: true },
          { status: "sent", id: "ses_c" },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const { results } = await provider.sendBatch([
      { from: "f@h.com", to: "a@example.com", subject: "s", html: "<p>a</p>" },
      { from: "f@h.com", to: "b@example.com", subject: "s", html: "<p>b</p>" },
      { from: "f@h.com", to: "c@example.com", subject: "s", html: "<p>c</p>" },
    ]);

    expect(results).toEqual([
      { id: "ses_a" },
      { id: "ses_b" },
      { id: "ses_c" },
    ]);
    const call = relay.calls[0];
    expect(call?.url).toBe("https://cloud.hogsend.com/api/email/send-batch");
    expect(call?.headers.authorization).toBe("Bearer hsrel_tenant_token");
    expect(call?.body.items).toHaveLength(3);
    expect(call?.body.items?.[0]?.message.to).toEqual(["a@example.com"]);
    expect(call?.body.items?.[2]?.message.to).toEqual(["c@example.com"]);
    // Per-item keys, never one key for the batch.
    for (const item of call?.body.items ?? []) {
      expect(item.idempotencyKey).toBeTruthy();
    }
  });

  it("takes each item's own Idempotency-Key header when supplied", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          { status: "sent", id: "ses_b" },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.sendBatch([
      {
        from: "f@h.com",
        to: "a@example.com",
        subject: "s",
        html: "<p>a</p>",
        headers: { "Idempotency-Key": "k_a" },
      },
      {
        from: "f@h.com",
        to: "b@example.com",
        subject: "s",
        html: "<p>b</p>",
        headers: { "Idempotency-Key": "k_b" },
      },
    ]);

    const items = relay.calls[0]?.body.items ?? [];
    expect(items.map((i) => i.idempotencyKey)).toEqual(["k_a", "k_b"]);
    expect(items[0]?.message).not.toHaveProperty("headers");
  });

  it("disambiguates identical auto-derived keys — the relay 400s duplicates", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          { status: "sent", id: "ses_b" },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const identical = {
      from: "f@h.com",
      to: "a@example.com",
      subject: "s",
      html: "<p>a</p>",
    };
    await provider.sendBatch([identical, { ...identical }]);

    const keys = (relay.calls[0]?.body.items ?? []).map(
      (i) => i.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("does NOT disambiguate a caller's duplicate keys — that is their bug", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          { status: "sent", id: "ses_b" },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await provider.sendBatch([
      {
        from: "f@h.com",
        to: "a@example.com",
        subject: "s",
        html: "<p>a</p>",
        headers: { "Idempotency-Key": "same" },
      },
      {
        from: "f@h.com",
        to: "b@example.com",
        subject: "s",
        html: "<p>b</p>",
        headers: { "Idempotency-Key": "same" },
      },
    ]);

    // Untouched, so the relay's `400 duplicate_idempotency_key` surfaces the
    // caller's mistake instead of this wire papering over it.
    expect(
      (relay.calls[0]?.body.items ?? []).map((i) => i.idempotencyKey),
    ).toEqual(["same", "same"]);
  });

  it("throws a typed batch error rather than fabricating an id", async () => {
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          {
            status: "failed",
            error: "send_rejected",
            message: "Email address is not verified",
          },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .sendBatch([
        {
          from: "f@h.com",
          to: "a@example.com",
          subject: "s",
          html: "<p>a</p>",
        },
        {
          from: "f@h.com",
          to: "b@example.com",
          subject: "s",
          html: "<p>b</p>",
        },
      ])
      .catch((e: unknown) => e)) as HogsendRelayBatchError;

    expect(error).toBeInstanceOf(HogsendRelayBatchError);
    // Nothing is lost: every positional outcome rides on the error, so a caller
    // can record the id that DID send.
    expect(error.results).toHaveLength(2);
    expect(error.results[0]).toEqual({ status: "sent", id: "ses_a" });
    expect(error.failures).toEqual([
      {
        index: 1,
        error: "send_rejected",
        message: "Email address is not verified",
      },
    ]);
    expect(relay.calls).toHaveLength(1);
  });

  it("surfaces a per-item send_in_progress failure with its slug intact", async () => {
    // The batch's in-flight shape: the relay reports a 200 whose item failed
    // with `send_in_progress` (its twin holds the claim). The slug must
    // survive verbatim so the caller can distinguish "retry in a moment" from
    // a real rejection.
    const relay = stubRelay({
      body: {
        results: [
          { status: "sent", id: "ses_a" },
          {
            status: "failed",
            error: "send_in_progress",
            message: "An identical send is at the wire right now.",
          },
        ],
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = (await provider
      .sendBatch([
        {
          from: "f@h.com",
          to: "a@example.com",
          subject: "s",
          html: "<p>a</p>",
        },
        {
          from: "f@h.com",
          to: "b@example.com",
          subject: "s",
          html: "<p>b</p>",
        },
      ])
      .catch((e: unknown) => e)) as HogsendRelayBatchError;

    expect(error).toBeInstanceOf(HogsendRelayBatchError);
    expect(error.failures).toEqual([
      {
        index: 1,
        error: "send_in_progress",
        message: "An identical send is at the wire right now.",
      },
    ]);
    expect(error.error).toBe("send_in_progress");
    // A partial batch is never a blanket retry decision.
    expect(error.retryable).toBe(false);
    expect(relay.calls).toHaveLength(1);
  });

  it("propagates a whole-batch 403 as the paused error", async () => {
    const relay = stubRelay({
      status: 403,
      body: {
        error: "tenant_paused",
        message: "paused",
        reason: "SES paused this tenant",
        pausedAt: "2026-08-10T09:30:00.000Z",
      },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    const error = await provider
      .sendBatch([
        {
          from: "f@h.com",
          to: "a@example.com",
          subject: "s",
          html: "<p>a</p>",
        },
      ])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HogsendRelayPausedError);
    expect(relay.calls).toHaveLength(1);
  });

  it("returns nothing and calls nothing for an empty batch", async () => {
    const relay = stubRelay();
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await expect(provider.sendBatch([])).resolves.toEqual({ results: [] });
    expect(relay.calls).toHaveLength(0);
  });

  it("throws when the relay's result count does not match the input", async () => {
    const relay = stubRelay({
      body: { results: [{ status: "sent", id: "ses_a" }] },
    });
    const provider = createHogsendEmailProvider({
      ...CONFIG,
      fetch: relay.fetch,
    });

    await expect(
      provider.sendBatch([
        {
          from: "f@h.com",
          to: "a@example.com",
          subject: "s",
          html: "<p>a</p>",
        },
        {
          from: "f@h.com",
          to: "b@example.com",
          subject: "s",
          html: "<p>b</p>",
        },
      ]),
    ).rejects.toThrow(HogsendRelayError);
  });
});
