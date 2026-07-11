import { defineSmsProvider, type SmsEvent } from "@hogsend/core";
import {
  createApp,
  createHogsendClient,
  defineWebhookSource,
  isE164,
  normalizePhone,
  synthesizeChannelLists,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";

// A minimal fake SMS provider so the container resolves an active provider
// without Twilio credentials in the test env.
const fakeProvider = defineSmsProvider({
  meta: { id: "fake-sms", name: "Fake SMS" },
  capabilities: { signedWebhooks: true, inboundMessages: true },
  async send() {
    return { id: "SMfake" };
  },
  verifyWebhook(): SmsEvent {
    // Always reject — the route maps a throw to 401 (verification failed).
    throw new Error("bad signature");
  },
  parseWebhook(): SmsEvent {
    return {
      type: "sms.delivered",
      messageId: "SMfake",
      phone: "+15551230000",
      occurredAt: new Date(0).toISOString(),
      raw: {},
    };
  },
});

describe("phone normalization", () => {
  it("accepts and normalizes valid E.164 with separators", () => {
    expect(normalizePhone(" +1 (555) 123-4567 ")).toBe("+15551234567");
    expect(isE164("+447911123456")).toBe(true);
  });

  it("rejects invalid numbers fail-closed", () => {
    expect(normalizePhone("5551234567")).toBeNull(); // no +
    expect(normalizePhone("+0555")).toBeNull(); // leading 0 country
    expect(normalizePhone("")).toBeNull();
    expect(isE164("not a phone")).toBe(false);
  });
});

describe("synthesizeChannelLists — sms channel", () => {
  it("mints an sms channel when configured", () => {
    const channels = synthesizeChannelLists([], { sms: true });
    const sms = channels.find((c) => c.id === "sms");
    expect(sms).toEqual({
      id: "sms",
      name: "SMS",
      defaultOptIn: true,
      enabled: true,
      kind: "channel",
    });
  });

  it("omits the sms channel when not configured", () => {
    const channels = synthesizeChannelLists([]);
    expect(channels.find((c) => c.id === "sms")).toBeUndefined();
  });
});

describe("SMS provider registry + webhook route", () => {
  const container = createHogsendClient({ sms: { provider: fakeProvider } });
  const app = createApp(container, {});

  it("registers and resolves the active SMS provider", () => {
    expect(container.smsProviders.get("fake-sms")).toBeDefined();
    expect(container.smsProvider?.meta.id).toBe("fake-sms");
  });

  it("exposes the sms channel in the list registry when configured", () => {
    expect(container.listRegistry.isChannel("sms")).toBe(true);
  });

  it("404s for an unknown SMS provider id", async () => {
    const res = await app.request("/v1/webhooks/sms/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "MessageStatus=delivered&MessageSid=SM1",
    });
    expect(res.status).toBe(404);
  });

  it("reaches the provider (401 on bad signature, not 404) and does not let the catch-all shadow it", async () => {
    const res = await app.request("/v1/webhooks/sms/fake-sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "MessageStatus=delivered&MessageSid=SM1&To=%2B15551230000",
    });
    expect(res.status).toBe(401);
  });
});

describe("reserved connector id", () => {
  it("throws when a webhook source claims the reserved id 'sms'", () => {
    const badSource = defineWebhookSource({
      meta: { id: "sms", name: "bad" },
      auth: { header: "x-secret", envKey: "SOME_SECRET", type: "match" },
      async transform() {
        return null;
      },
    });
    expect(() => createHogsendClient({ webhookSources: [badSource] })).toThrow(
      /reserved/i,
    );
  });
});
