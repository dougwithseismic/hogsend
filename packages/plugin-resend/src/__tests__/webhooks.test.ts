import { WebhookVerificationError } from "@hogsend/email";
import { describe, expect, it } from "vitest";
import type { EmailSentEvent } from "../types.js";
import { createWebhookHandler, parseWebhookEvent } from "../webhooks.js";

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

describe("parseWebhookEvent", () => {
  it("parses a valid sent event", () => {
    const event = makeSentEvent();
    const parsed = parseWebhookEvent(JSON.stringify(event));
    expect(parsed.type).toBe("email.sent");
    expect(parsed.data.email_id).toBe("email_123");
  });

  it("parses a valid bounced event", () => {
    const event = {
      type: "email.bounced",
      created_at: "2024-01-01T00:00:00Z",
      data: {
        email_id: "email_456",
        from: "test@hogsend.com",
        to: ["user@example.com"],
        subject: "Test",
        created_at: "2024-01-01T00:00:00Z",
        bounce: { message: "Mailbox not found", type: "hard" },
      },
    };
    const parsed = parseWebhookEvent(JSON.stringify(event));
    expect(parsed.type).toBe("email.bounced");
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
