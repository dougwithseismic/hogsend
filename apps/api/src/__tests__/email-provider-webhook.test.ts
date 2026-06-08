import {
  createApp,
  createHogsendClient,
  defineWebhookSource,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import { webhookSources } from "../webhook-sources/index.js";

const container = createHogsendClient();
const app = createApp(container, { webhookSources });

describe("email provider registry (container)", () => {
  it("exposes an emailProviders registry with the active resend provider", () => {
    expect(container.emailProviders.count()).toBeGreaterThanOrEqual(1);
    expect(container.emailProviders.get("resend")).toBeDefined();
    expect(container.emailProvider).toBeDefined();
    expect(container.emailProvider.meta?.id).toBe("resend");
  });
});

describe("POST /v1/webhooks/email/:providerId", () => {
  it("reaches the handler for a registered provider (not 404)", async () => {
    const res = await app.request("/v1/webhooks/email/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.sent" }),
    });

    // No valid signature → 401, but it MUST have resolved the provider (≠ 404).
    expect(res.status).not.toBe(404);
  });

  it("404s for an unknown provider id", async () => {
    const res = await app.request("/v1/webhooks/email/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.sent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Unknown email provider");
  });

  it("does not let the :sourceId catch-all shadow the email prefix", async () => {
    // `email` resolves to the provider route, never the consumer-source map.
    const res = await app.request("/v1/webhooks/email/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.sent" }),
    });
    // The source catch-all would 404 "Unknown webhook source"; the provider
    // route returns 401 (signature) for a registered provider.
    expect(res.status).toBe(401);
  });
});

describe("/v1/webhooks/resend alias", () => {
  it("still reaches the handler (not 404)", async () => {
    const res = await app.request("/v1/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.sent" }),
    });

    expect(res.status).not.toBe(404);
  });
});

describe("reserved `email` webhook source id", () => {
  it("throws at registration when a source uses meta.id === 'email'", () => {
    const offending = defineWebhookSource({
      meta: { id: "email", name: "Shadowing source" },
      auth: { header: "x-secret", envKey: "TEST_SECRET", type: "match" },
      async transform() {
        return null;
      },
    });

    expect(() =>
      createApp(createHogsendClient(), { webhookSources: [offending] }),
    ).toThrow(/reserved/i);
  });
});
