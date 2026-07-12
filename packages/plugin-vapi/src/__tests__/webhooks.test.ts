import { WebhookHandshakeSignal } from "@hogsend/core";
import { describe, expect, it } from "vitest";
import {
  encodeToolResults,
  parseWebhook,
  toVoiceWebhook,
  verifyWebhook,
} from "../webhooks.js";

const SECRET = "vapi_server_secret_deadbeef";
const URL = "https://api.example.com/v1/webhooks/voice/vapi";

function body(message: Record<string, unknown>): string {
  return JSON.stringify({ message });
}

describe("verifyWebhook", () => {
  const payload = body({
    type: "status-update",
    status: "ringing",
    call: { id: "call_1", customer: { number: "+15551230000" } },
  });

  it("accepts a request whose X-Vapi-Secret matches", () => {
    const parsed = verifyWebhook({
      payload,
      headers: { "x-vapi-secret": SECRET },
      url: URL,
      secret: SECRET,
    });
    expect(parsed.kind).toBe("event");
  });

  it("fails closed on a mismatched secret", () => {
    expect(() =>
      verifyWebhook({
        payload,
        headers: { "x-vapi-secret": "wrong" },
        url: URL,
        secret: SECRET,
      }),
    ).toThrow(/secret verification failed/);
  });

  it("fails closed when the secret header is missing (secret configured)", () => {
    expect(() =>
      verifyWebhook({ payload, headers: {}, url: URL, secret: SECRET }),
    ).toThrow(/Missing X-Vapi-Secret/);
  });

  it("accepts an Authorization: Bearer token matching the secret", () => {
    const parsed = verifyWebhook({
      payload,
      headers: { authorization: `Bearer ${SECRET}` },
      url: URL,
      secret: SECRET,
    });
    expect(parsed.kind).toBe("event");
  });

  it("ACCEPTS an unverified request when NO secret is configured", () => {
    // A basic VAPI_API_KEY-only deploy has no secret; verification is skipped so
    // status/tool/outcome webhooks aren't all 401'd.
    const parsed = verifyWebhook({ payload, headers: {}, url: URL });
    expect(parsed.kind).toBe("event");
  });
});

describe("toVoiceWebhook — inbound assistant request", () => {
  it("normalizes an assistant-request into the inbound kind", () => {
    const parsed = toVoiceWebhook({
      type: "assistant-request",
      call: {
        id: "call_in",
        customer: { number: "+15551112222" },
        phoneNumber: { number: "+15559990000" },
      },
    });
    expect(parsed.kind).toBe("assistant_request");
    if (parsed.kind === "assistant_request") {
      expect(parsed.request.caller).toBe("+15551112222");
      expect(parsed.request.called).toBe("+15559990000");
    }
  });
});

describe("toVoiceWebhook — tool calls", () => {
  it("normalizes a tool-calls message into a tool_call result (parameters field)", () => {
    const parsed = toVoiceWebhook({
      type: "tool-calls",
      call: { id: "call_1" },
      // Vapi's current schema puts the model args under `parameters`.
      toolCallList: [
        {
          id: "tc_1",
          name: "bookAppointment",
          parameters: { slotIso: "2026-08-01T15:00:00Z" },
        },
      ],
    });
    expect(parsed).toEqual({
      kind: "tool_call",
      calls: [
        {
          callId: "call_1",
          toolCallId: "tc_1",
          name: "bookAppointment",
          args: { slotIso: "2026-08-01T15:00:00Z" },
        },
      ],
    });
  });

  it("parses string-encoded arguments", () => {
    const parsed = toVoiceWebhook({
      type: "tool-calls",
      call: { id: "c" },
      toolCallList: [
        { id: "tc", function: { name: "x", arguments: '{"a":1}' } },
      ],
    });
    expect(parsed.kind).toBe("tool_call");
    if (parsed.kind === "tool_call") {
      expect(parsed.calls[0]?.args).toEqual({ a: 1 });
    }
  });

  it("throws a handshake for an empty tool-call list", () => {
    expect(() =>
      toVoiceWebhook({ type: "tool-calls", toolCallList: [] }),
    ).toThrow(WebhookHandshakeSignal);
  });
});

describe("toVoiceWebhook — status updates", () => {
  it("emits voice.call_started for ringing", () => {
    const parsed = toVoiceWebhook({
      type: "status-update",
      status: "ringing",
      call: { id: "c", customer: { number: "+15551230000" } },
    });
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.event.type).toBe("voice.call_started");
      expect(parsed.event.phone).toBe("+15551230000");
    }
  });

  it.each([
    "queued",
    "in-progress",
    "forwarding",
    "ended",
  ])("handshakes intermediate/terminal status %s (no dispatch)", (status) => {
    expect(() =>
      toVoiceWebhook({ type: "status-update", status, call: { id: "c" } }),
    ).toThrow(WebhookHandshakeSignal);
  });
});

describe("toVoiceWebhook — end-of-call report", () => {
  const base = {
    type: "end-of-call-report",
    call: { id: "call_9", customer: { number: "+15551112222" } },
    durationSeconds: 62,
    cost: 0.14,
    summary: "Booked a demo.",
    analysis: {
      structuredData: { interested: true, budget: "high" },
    },
    artifact: {
      recordingUrl: "https://rec.example.com/a.mp3",
      messages: [
        { role: "bot", message: "Hi there", secondsFromStart: 0 },
        { role: "user", message: "Yes, book it", secondsFromStart: 4 },
      ],
    },
  };

  it("maps a normal hangup to voice.call_ended with the full outcome", () => {
    const parsed = toVoiceWebhook({
      ...base,
      endedReason: "customer-ended-call",
    });
    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") return;
    expect(parsed.event.type).toBe("voice.call_ended");
    expect(parsed.event.phone).toBe("+15551112222");
    expect(parsed.event.ended).toMatchObject({
      reason: "customer-ended-call",
      durationSec: 62,
      cost: 0.14,
      recordingUrl: "https://rec.example.com/a.mp3",
      summary: "Booked a demo.",
      structuredData: { interested: true, budget: "high" },
    });
    expect(parsed.event.ended?.transcript).toEqual([
      { role: "agent", text: "Hi there", at: 0 },
      { role: "user", text: "Yes, book it", at: 4 },
    ]);
  });

  it("maps a no-answer ending to voice.no_answer", () => {
    const parsed = toVoiceWebhook({
      ...base,
      endedReason: "customer-did-not-answer",
    });
    if (parsed.kind !== "event") throw new Error("expected event");
    expect(parsed.event.type).toBe("voice.no_answer");
  });

  it("maps a voicemail ending to voice.voicemail", () => {
    const parsed = toVoiceWebhook({ ...base, endedReason: "voicemail" });
    if (parsed.kind !== "event") throw new Error("expected event");
    expect(parsed.event.type).toBe("voice.voicemail");
  });

  it("maps a pipeline error to voice.failed with a transient class", () => {
    const parsed = toVoiceWebhook({
      ...base,
      endedReason: "pipeline-error-openai",
    });
    if (parsed.kind !== "event") throw new Error("expected event");
    expect(parsed.event.type).toBe("voice.failed");
    expect(parsed.event.failure?.class).toBe("transient");
  });

  it("flags an inbound call", () => {
    const parsed = toVoiceWebhook({
      ...base,
      endedReason: "hangup",
      call: { ...base.call, type: "inboundPhoneCall" },
      phoneNumber: { number: "+15559990000" },
    });
    if (parsed.kind !== "event") throw new Error("expected event");
    expect(parsed.event.inbound).toEqual({ to: "+15559990000" });
  });
});

describe("toVoiceWebhook — unhandled", () => {
  it("throws a handshake for an unknown message type", () => {
    expect(() => toVoiceWebhook({ type: "transcript" })).toThrow(
      WebhookHandshakeSignal,
    );
  });
});

describe("parseWebhook + encodeToolResults", () => {
  it("parses the { message } envelope", () => {
    const parsed = parseWebhook(
      body({ type: "status-update", status: "ringing", call: { id: "c" } }),
    );
    expect(parsed.kind).toBe("event");
  });

  it("encodes tool results into Vapi's { results } shape", () => {
    expect(
      encodeToolResults([{ toolCallId: "tc_1", result: '{"booked":true}' }]),
    ).toEqual({ results: [{ toolCallId: "tc_1", result: '{"booked":true}' }] });
  });
});
