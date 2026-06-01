import {
  createApp,
  createHogsendClient,
  defineWebhookSource,
} from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import { webhookSources } from "../webhook-sources/index.js";
import { posthogSource } from "../webhook-sources/posthog.js";

const container = createHogsendClient();
const app = createApp(container, { webhookSources });

describe("defineWebhookSource", () => {
  it("returns the source definition unchanged", () => {
    const source = defineWebhookSource({
      meta: { id: "test", name: "Test" },
      auth: { header: "x-test-secret", envKey: "TEST_SECRET", type: "match" },
      async transform(payload: { foo: string }) {
        return {
          event: payload.foo,
          userId: "u1",
          userEmail: "",
          properties: {},
        };
      },
    });

    expect(source.meta.id).toBe("test");
    expect(source.meta.name).toBe("Test");
    expect(source.auth.header).toBe("x-test-secret");
    expect(source.transform).toBeTypeOf("function");
  });

  it("transform can return null to skip events", async () => {
    const source = defineWebhookSource({
      meta: { id: "skip", name: "Skip" },
      auth: { header: "x-skip", envKey: "SKIP", type: "match" },
      async transform() {
        return null;
      },
    });

    const result = await source.transform(
      {},
      { db: {} as never, logger: {} as never },
    );
    expect(result).toBeNull();
  });
});

describe("PostHog source transform (unit)", () => {
  const ctx = { db: {} as never, logger: {} as never };

  it("maps PostHog payload to IngestEvent", async () => {
    const result = await posthogSource.transform(
      {
        event: {
          uuid: "evt-123",
          event: "user.created",
          distinct_id: "user-456",
          properties: { plan: "pro" },
        },
        person: {
          properties: { email: "test@example.com", name: "Test User" },
        },
      },
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result?.event).toBe("user.created");
    expect(result?.userId).toBe("user-456");
    expect(result?.userEmail).toBe("test@example.com");
    expect(result?.properties).toEqual({
      plan: "pro",
      email: "test@example.com",
      name: "Test User",
      _posthogEventId: "evt-123",
    });
  });

  it("handles missing person and email", async () => {
    const result = await posthogSource.transform(
      {
        event: {
          event: "page.viewed",
          distinct_id: "user-789",
        },
      },
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result?.event).toBe("page.viewed");
    expect(result?.userId).toBe("user-789");
    expect(result?.userEmail).toBe("");
  });

  it("merges event and person properties", async () => {
    const result = await posthogSource.transform(
      {
        event: {
          event: "signup",
          distinct_id: "u1",
          properties: { source: "google", plan: "free" },
        },
        person: {
          properties: { email: "a@b.com", plan: "pro" },
        },
      },
      ctx,
    );

    expect(result?.properties.source).toBe("google");
    expect(result?.properties.plan).toBe("pro");
    expect(result?.properties.email).toBe("a@b.com");
  });

  it("includes posthog event uuid when present", async () => {
    const result = await posthogSource.transform(
      {
        event: { uuid: "abc-123", event: "test", distinct_id: "u1" },
      },
      ctx,
    );

    expect(result?.properties._posthogEventId).toBe("abc-123");
  });

  it("excludes posthog event uuid when absent", async () => {
    const result = await posthogSource.transform(
      {
        event: { event: "test", distinct_id: "u1" },
      },
      ctx,
    );

    expect(result?.properties._posthogEventId).toBeUndefined();
  });
});

describe("Webhook source router", () => {
  it("returns 404 for unknown source", async () => {
    const res = await app.request("/v1/webhooks/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "test" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Unknown webhook source");
  });

  it("returns 400 for invalid payload against schema", async () => {
    const res = await app.request("/v1/webhooks/posthog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "a posthog payload" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });

  it("does not conflict with resend webhook route", async () => {
    const res = await app.request("/v1/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "email.sent" }),
    });

    expect(res.status).not.toBe(404);
  });
});
