import type { LegacyResendWebhookEvent } from "@hogsend/core";
import { WebhookVerificationError } from "@hogsend/email";
import { describe, expect, it } from "vitest";
import type { EmailSentEvent } from "../types.js";
import {
  classifyResendBounce,
  createWebhookHandler,
  parseWebhookEvent,
} from "../webhooks.js";

function makeSentEvent(): EmailSentEvent {
  return {
    type: "email.sent",
    created_at: "2024-01-01T00:00:00Z",
    data: {
      email_id: "email_123",
      from: "test@hogsend.com",
      to: ["user@example.com"],
      subject: "Test",
      created_at: "2024-01-01T00:00:00Z",
    },
  };
}

describe("parseWebhookEvent → EmailEvent", () => {
  it("normalizes a sent event into the neutral shape", () => {
    const event = makeSentEvent();
    const parsed = parseWebhookEvent(JSON.stringify(event));
    expect(parsed.type).toBe("email.sent");
    expect(parsed.messageId).toBe("email_123");
    expect(parsed.recipients).toEqual(["user@example.com"]);
    expect(parsed.occurredAt).toBe("2024-01-01T00:00:00Z");
    // `raw` is the escape hatch: still readable via the legacy union cast.
    const legacy = parsed.raw as LegacyResendWebhookEvent;
    expect(legacy.data.email_id).toBe("email_123");
  });

  it("normalizes a bounced event with the bounce class table", () => {
    const event = {
      type: "email.bounced",
      created_at: "2024-01-01T00:00:00Z",
      data: {
        email_id: "email_456",
        from: "test@hogsend.com",
        to: ["user@example.com"],
        subject: "Test",
        created_at: "2024-01-01T00:00:00Z",
        bounce: { message: "Mailbox not found", type: "HardBounce" },
      },
    };
    const parsed = parseWebhookEvent(JSON.stringify(event));
    expect(parsed.type).toBe("email.bounced");
    expect(parsed.bounce).toEqual({
      class: "permanent",
      code: "HardBounce",
      reason: "Mailbox not found",
    });
  });

  it("normalizes a clicked event into the neutral click shape", () => {
    const event = {
      type: "email.clicked",
      created_at: "2024-01-01T00:00:00Z",
      data: {
        email_id: "email_789",
        from: "test@hogsend.com",
        to: ["user@example.com"],
        subject: "Test",
        created_at: "2024-01-01T00:00:00Z",
        click: {
          link: "https://hogsend.com/x",
          timestamp: "2024-01-01T00:01:00Z",
          ipAddress: "1.2.3.4",
          userAgent: "Mozilla",
        },
      },
    };
    const parsed = parseWebhookEvent(JSON.stringify(event));
    expect(parsed.type).toBe("email.clicked");
    expect(parsed.click).toEqual({
      url: "https://hogsend.com/x",
      at: "2024-01-01T00:01:00Z",
      ip: "1.2.3.4",
      ua: "Mozilla",
    });
  });

  it("throws on unknown event type", () => {
    const event = { type: "email.unknown", data: {} };
    expect(() => parseWebhookEvent(JSON.stringify(event))).toThrow(
      WebhookVerificationError,
    );
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWebhookEvent("not json")).toThrow();
  });
});

describe("classifyResendBounce (the free-string → class table)", () => {
  const cases: Array<[string, string]> = [
    ["HardBounce", "permanent"],
    ["Permanent", "permanent"],
    ["SuppressedRecipient", "permanent"],
    ["Suppressed", "permanent"],
    ["SoftBounce", "transient"],
    ["Transient", "transient"],
    ["MailboxFull", "transient"],
    ["Throttled", "transient"],
    ["Undetermined", "transient"],
    ["Complaint", "complaint"],
    ["Spam", "complaint"],
    ["Abuse", "complaint"],
    ["SomethingNew", "unknown"],
    ["", "unknown"],
  ];

  for (const [input, expected] of cases) {
    it(`maps "${input}" → ${expected}`, () => {
      expect(classifyResendBounce(input)).toBe(expected);
    });
  }

  it("is case-insensitive and substring-based", () => {
    expect(classifyResendBounce("a HardBounce occurred")).toBe("permanent");
    expect(classifyResendBounce("a spam complaint")).toBe("complaint");
    expect(classifyResendBounce("HARDBOUNCE")).toBe("permanent");
  });

  it("treats undefined as unknown (no suppression)", () => {
    expect(classifyResendBounce(undefined)).toBe("unknown");
  });
});

describe("createWebhookHandler", () => {
  it("requires valid svix headers", async () => {
    const handler = createWebhookHandler({
      signingSecret: "whsec_test",
      handlers: {},
    });
    await expect(handler(JSON.stringify(makeSentEvent()), {})).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("requires svix headers to be present", async () => {
    const handler = createWebhookHandler({
      signingSecret: "whsec_test",
      handlers: {},
    });
    await expect(
      handler(JSON.stringify(makeSentEvent()), {
        "svix-id": "msg_123",
      }),
    ).rejects.toThrow("Missing required Svix headers");
  });
});
