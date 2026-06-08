import { WebhookHandshakeSignal } from "@hogsend/core";
import { Models } from "postmark";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the args every ServerClient method is called with, so we can assert on
// the wire mapping without hitting the network.
const sendEmail = vi.fn();
const sendEmailBatch = vi.fn();

vi.mock("postmark", async () => {
  const actual = await vi.importActual<typeof import("postmark")>("postmark");
  class MockServerClient {
    sendEmail = sendEmail;
    sendEmailBatch = sendEmailBatch;
  }
  return {
    ...actual,
    ServerClient: MockServerClient,
  };
});

// Imported AFTER the mock so the provider picks up the mocked ServerClient.
const { classifyPostmarkBounce, createPostmarkProvider, parsePostmarkWebhook } =
  await import("../index.js");

const SEND_OK = { ErrorCode: 0, Message: "OK", MessageID: "pm_msg_1" };

beforeEach(() => {
  sendEmail.mockReset();
  sendEmailBatch.mockReset();
});

describe("send → Postmark message mapping", () => {
  it("forces native tracking OFF and maps neutral fields to Postmark", async () => {
    sendEmail.mockResolvedValue(SEND_OK);
    const provider = createPostmarkProvider({ serverToken: "pm_token" });

    const result = await provider.send({
      from: "from@hogsend.com",
      to: ["a@example.com", "b@example.com"],
      cc: "cc@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      replyTo: "reply@hogsend.com",
      tag: "welcome",
      metadata: { userId: "u_1" },
      headers: { "X-Custom": "v" },
    });

    expect(result).toEqual({ id: "pm_msg_1" });
    // biome-ignore lint/style/noNonNullAssertion: the mock was just invoked.
    const msg = sendEmail.mock.calls[0]![0];
    // Sovereign invariant: native open/click tracking is forced off per-send.
    expect(msg.TrackOpens).toBe(false);
    expect(msg.TrackLinks).toBe(Models.LinkTrackingOptions.None);
    // HTML-only wire — no React ever reaches Postmark.
    expect(msg.HtmlBody).toBe("<p>hi</p>");
    expect(msg.TextBody).toBe("hi");
    expect("react" in msg).toBe(false);
    // Recipient lists are joined into Postmark's comma string format.
    expect(msg.To).toBe("a@example.com,b@example.com");
    expect(msg.Cc).toBe("cc@example.com");
    expect(msg.From).toBe("from@hogsend.com");
    expect(msg.ReplyTo).toBe("reply@hogsend.com");
    expect(msg.Subject).toBe("Hello");
    expect(msg.Tag).toBe("welcome");
    expect(msg.Metadata).toEqual({ userId: "u_1" });
    expect(msg.Headers).toEqual([{ Name: "X-Custom", Value: "v" }]);
    expect(msg.MessageStream).toBe("outbound");
  });

  it("honors a custom message stream", async () => {
    sendEmail.mockResolvedValue(SEND_OK);
    const provider = createPostmarkProvider({
      serverToken: "pm_token",
      messageStream: "broadcasts",
    });
    await provider.send({
      from: "f@h.com",
      to: "t@h.com",
      subject: "s",
      html: "<p>x</p>",
    });
    // biome-ignore lint/style/noNonNullAssertion: the mock was just invoked.
    expect(sendEmail.mock.calls[0]![0].MessageStream).toBe("broadcasts");
  });

  it("throws on a non-zero Postmark ErrorCode", async () => {
    sendEmail.mockResolvedValue({
      ErrorCode: 406,
      Message: "Inactive recipient",
      MessageID: "",
    });
    const provider = createPostmarkProvider({ serverToken: "pm_token" });
    await expect(
      provider.send({
        from: "f@h.com",
        to: "t@h.com",
        subject: "s",
        html: "<p>x</p>",
      }),
    ).rejects.toThrow("Postmark 406: Inactive recipient");
  });

  it("sendBatch forces tracking off on every item and maps ids", async () => {
    sendEmailBatch.mockResolvedValue([
      { ErrorCode: 0, Message: "OK", MessageID: "pm_a" },
      { ErrorCode: 0, Message: "OK", MessageID: "pm_b" },
    ]);
    const provider = createPostmarkProvider({ serverToken: "pm_token" });
    const { results } = await provider.sendBatch([
      { from: "f@h.com", to: "a@h.com", subject: "s", html: "<p>a</p>" },
      { from: "f@h.com", to: "b@h.com", subject: "s", html: "<p>b</p>" },
    ]);
    expect(results).toEqual([{ id: "pm_a" }, { id: "pm_b" }]);
    // biome-ignore lint/style/noNonNullAssertion: the mock was just invoked.
    const messages = sendEmailBatch.mock.calls[0]![0];
    for (const m of messages) {
      expect(m.TrackOpens).toBe(false);
      expect(m.TrackLinks).toBe(Models.LinkTrackingOptions.None);
    }
  });
});

describe("verifyWebhook fail-closed auth", () => {
  const payload = JSON.stringify({
    RecordType: "Delivery",
    MessageID: "pm_msg_1",
    Recipient: "user@example.com",
    DeliveredAt: "2024-01-01T00:00:00Z",
  });
  const basicAuth = { user: "hogsend", pass: "secret" };
  const goodHeader = `Basic ${Buffer.from("hogsend:secret").toString("base64")}`;

  it("FAILS CLOSED when webhook auth is unconfigured", () => {
    const provider = createPostmarkProvider({ serverToken: "pm_token" });
    expect(() =>
      provider.verifyWebhook({
        payload,
        headers: { authorization: goodHeader },
      }),
    ).toThrow("Postmark webhook auth not configured");
  });

  it("rejects a missing Authorization header", () => {
    const provider = createPostmarkProvider({
      serverToken: "pm_token",
      webhookBasicAuth: basicAuth,
    });
    expect(() => provider.verifyWebhook({ payload, headers: {} })).toThrow(
      "Postmark webhook auth failed",
    );
  });

  it("rejects a mismatched Authorization header", () => {
    const provider = createPostmarkProvider({
      serverToken: "pm_token",
      webhookBasicAuth: basicAuth,
    });
    const wrong = `Basic ${Buffer.from("hogsend:wrong").toString("base64")}`;
    expect(() =>
      provider.verifyWebhook({ payload, headers: { authorization: wrong } }),
    ).toThrow("Postmark webhook auth failed");
  });

  it("accepts the correct Basic creds and returns a normalized event", async () => {
    const provider = createPostmarkProvider({
      serverToken: "pm_token",
      webhookBasicAuth: basicAuth,
    });
    // verifyWebhook may be sync OR async per the contract — await covers both.
    const event = await provider.verifyWebhook({
      payload,
      headers: { authorization: goodHeader },
    });
    expect(event.type).toBe("email.delivered");
    expect(event.messageId).toBe("pm_msg_1");
    expect(event.recipients).toEqual(["user@example.com"]);
  });
});

describe("parsePostmarkWebhook RecordType → EmailEvent", () => {
  it("maps Delivery → email.delivered", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Delivery",
        MessageID: "pm_1",
        Recipient: "u@example.com",
        DeliveredAt: "2024-01-01T00:00:00Z",
      }),
    );
    expect(event.type).toBe("email.delivered");
    expect(event.occurredAt).toBe("2024-01-01T00:00:00Z");
  });

  it("maps Open → email.opened (native echo, status no-op)", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Open",
        MessageID: "pm_1",
        Recipient: "u@example.com",
        ReceivedAt: "2024-01-01T00:01:00Z",
      }),
    );
    expect(event.type).toBe("email.opened");
  });

  it("maps Click → email.clicked with the click payload", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Click",
        MessageID: "pm_1",
        Recipient: "u@example.com",
        ReceivedAt: "2024-01-01T00:02:00Z",
        OriginalLink: "https://hogsend.com/x",
        UserAgent: "Mozilla",
      }),
    );
    expect(event.type).toBe("email.clicked");
    expect(event.click).toEqual({
      url: "https://hogsend.com/x",
      at: "2024-01-01T00:02:00Z",
      ua: "Mozilla",
    });
  });

  it("maps SpamComplaint → email.complained (class: complaint)", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "SpamComplaint",
        MessageID: "pm_1",
        Email: "u@example.com",
        BouncedAt: "2024-01-01T00:00:00Z",
        Description: "User marked as spam",
      }),
    );
    expect(event.type).toBe("email.complained");
    expect(event.bounce).toEqual({
      class: "complaint",
      code: "SpamComplaint",
      reason: "User marked as spam",
    });
    expect(event.recipients).toEqual(["u@example.com"]);
  });

  it("throws WebhookHandshakeSignal for a non-status RecordType", () => {
    expect(() =>
      parsePostmarkWebhook(
        JSON.stringify({
          RecordType: "SubscriptionChange",
          MessageID: "pm_1",
          Recipient: "u@example.com",
        }),
      ),
    ).toThrow(WebhookHandshakeSignal);
  });
});

describe("Bounce TypeCode → class mapping", () => {
  // The spec table: HardBounce=1, Transient=2, DnsError=256,
  // SpamNotification=512, SoftBounce=4096, BadEmailAddress=100000,
  // SpamComplaint=100001, Blocked=100006.
  const cases: Array<[number, string, string]> = [
    [1, "HardBounce", "permanent"],
    [2, "Transient", "transient"],
    [256, "DnsError", "transient"],
    [512, "SpamNotification", "complaint"],
    [4096, "SoftBounce", "transient"],
    [100000, "BadEmailAddress", "permanent"],
    [100001, "SpamComplaint", "complaint"],
    [100006, "Blocked", "permanent"],
  ];

  for (const [typeCode, , expected] of cases) {
    it(`TypeCode ${typeCode} → ${expected}`, () => {
      expect(classifyPostmarkBounce(typeCode)).toBe(expected);
    });
  }

  it("maps a permanent Bounce → email.bounced class:permanent", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Bounce",
        MessageID: "pm_1",
        Email: "u@example.com",
        TypeCode: 1,
        Type: "HardBounce",
        BouncedAt: "2024-01-01T00:00:00Z",
        Description: "Mailbox not found",
      }),
    );
    expect(event.type).toBe("email.bounced");
    expect(event.bounce).toEqual({
      class: "permanent",
      code: "HardBounce",
      reason: "Mailbox not found",
    });
  });

  it("maps a transient (soft) Bounce → email.bounced class:transient", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Bounce",
        MessageID: "pm_1",
        Email: "u@example.com",
        TypeCode: 4096,
        Type: "SoftBounce",
        BouncedAt: "2024-01-01T00:00:00Z",
      }),
    );
    // Recorded as bounced, carrying transient class — the engine records but
    // does NOT increment the suppression counter for these.
    expect(event.type).toBe("email.bounced");
    expect(event.bounce?.class).toBe("transient");
  });

  it("routes a complaint-class Bounce → email.complained", () => {
    const event = parsePostmarkWebhook(
      JSON.stringify({
        RecordType: "Bounce",
        MessageID: "pm_1",
        Email: "u@example.com",
        TypeCode: 100001,
        Type: "SpamComplaint",
        BouncedAt: "2024-01-01T00:00:00Z",
      }),
    );
    expect(event.type).toBe("email.complained");
    expect(event.bounce?.class).toBe("complaint");
  });
});
