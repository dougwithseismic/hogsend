import { createHmac } from "node:crypto";
import { WebhookHandshakeSignal } from "@hogsend/core";
import { describe, expect, it } from "vitest";
import { parseWebhook, toSmsEvent, verifyWebhook } from "../webhooks.js";

const AUTH_TOKEN = "test_auth_token_deadbeef";
const URL = "https://api.example.com/v1/webhooks/sms/twilio";

/**
 * Compute the X-Twilio-Signature exactly as Twilio does: take the full URL,
 * append each POST param sorted by key as `key + value` concatenated, HMAC-SHA1
 * with the auth token, base64.
 */
function twilioSignature(
  url: string,
  params: Record<string, string>,
  authToken = AUTH_TOKEN,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

function formEncode(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("verifyWebhook", () => {
  it("accepts a correctly-signed delivered status callback", () => {
    const params = {
      MessageSid: "SM123",
      MessageStatus: "delivered",
      To: "+15551230000",
      From: "+15559990000",
    };
    const event = verifyWebhook({
      payload: formEncode(params),
      headers: { "x-twilio-signature": twilioSignature(URL, params) },
      url: URL,
      authToken: AUTH_TOKEN,
    });
    expect(event.type).toBe("sms.delivered");
    expect(event.messageId).toBe("SM123");
    expect(event.phone).toBe("+15551230000");
  });

  it("rejects a tampered payload", () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered", To: "+1" };
    const sig = twilioSignature(URL, params);
    const tampered = { ...params, To: "+9999999" };
    expect(() =>
      verifyWebhook({
        payload: formEncode(tampered),
        headers: { "x-twilio-signature": sig },
        url: URL,
        authToken: AUTH_TOKEN,
      }),
    ).toThrow(/signature verification failed/);
  });

  it("fails closed when the signature header is missing", () => {
    expect(() =>
      verifyWebhook({
        payload: "MessageStatus=delivered",
        headers: {},
        url: URL,
        authToken: AUTH_TOKEN,
      }),
    ).toThrow(/Missing X-Twilio-Signature/);
  });
});

describe("toSmsEvent mapping", () => {
  it("maps failed status with a permanent error code", () => {
    const event = toSmsEvent({
      MessageSid: "SM9",
      MessageStatus: "failed",
      To: "+15551112222",
      ErrorCode: "30003",
      ErrorMessage: "Unreachable",
    });
    expect(event.type).toBe("sms.failed");
    expect(event.failure).toEqual({
      class: "permanent",
      code: "30003",
      reason: "Unreachable",
    });
  });

  it("maps an unknown error code to the conservative unknown class", () => {
    const event = toSmsEvent({
      MessageSid: "SM9",
      MessageStatus: "undelivered",
      To: "+1",
      ErrorCode: "30001",
    });
    expect(event.type).toBe("sms.failed");
    expect(event.failure?.class).toBe("unknown");
  });

  it("maps an inbound MO message", () => {
    const event = toSmsEvent({
      MessageSid: "SM_in",
      From: "+15551112222",
      To: "+15559990000",
      Body: "STOP",
    });
    expect(event.type).toBe("sms.inbound");
    expect(event.phone).toBe("+15551112222");
    expect(event.inbound).toEqual({ body: "STOP", to: "+15559990000" });
  });

  it("throws a handshake signal for intermediate statuses", () => {
    expect(() =>
      toSmsEvent({ MessageSid: "SM1", MessageStatus: "queued", To: "+1" }),
    ).toThrow(WebhookHandshakeSignal);
  });

  it("throws a handshake signal for an unrecognized payload", () => {
    expect(() => toSmsEvent({ Foo: "bar" })).toThrow(WebhookHandshakeSignal);
  });
});

describe("parseWebhook", () => {
  it("parses an unsigned status callback", () => {
    const event = parseWebhook(
      "MessageSid=SM1&MessageStatus=sent&To=%2B15551230000",
    );
    expect(event.type).toBe("sms.sent");
    expect(event.phone).toBe("+15551230000");
  });
});
