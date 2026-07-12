import { describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  normalizeWebhookContactEvent,
  webhookContactPayloadSchema,
  webhookContactSource,
  isColdChannelAllowed,
} = await import("@hogsend/engine");

describe("webhookContactPayloadSchema", () => {
  it("accepts a payload with an email", () => {
    const parsed = webhookContactPayloadSchema.safeParse({
      event: "prospect.sourced",
      email: "a@example.com",
      properties: { company: "Acme" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a payload with only external_id", () => {
    const parsed = webhookContactPayloadSchema.safeParse({
      event: "prospect.sourced",
      external_id: "crm-123",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload with neither email nor external_id", () => {
    const parsed = webhookContactPayloadSchema.safeParse({
      event: "prospect.sourced",
      properties: { company: "Acme" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty event name", () => {
    const parsed = webhookContactPayloadSchema.safeParse({
      event: "",
      email: "a@example.com",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("normalizeWebhookContactEvent", () => {
  it("maps the normalized payload onto an IngestEvent (email → userEmail, external_id → userId, properties → contactProperties)", () => {
    const ev = normalizeWebhookContactEvent({
      event: "prospect.sourced",
      email: "a@example.com",
      external_id: "crm-1",
      anonymous_id: "anon-1",
      properties: { company: "Acme" },
      event_properties: { score: 8 },
      idempotency_key: "row-42",
      occurred_at: "2026-07-12T00:00:00.000Z",
    });
    expect(ev).toEqual({
      event: "prospect.sourced",
      userEmail: "a@example.com",
      userId: "crm-1",
      anonymousId: "anon-1",
      contactProperties: { company: "Acme" },
      eventProperties: { score: 8 },
      idempotencyKey: "row-42",
      occurredAt: "2026-07-12T00:00:00.000Z",
    });
    // Provenance (`source`) is stamped by the route, not the transform.
    expect("source" in ev).toBe(false);
  });

  it("defaults eventProperties to {} and leaves contactProperties undefined", () => {
    const ev = normalizeWebhookContactEvent({
      event: "e",
      email: "a@example.com",
    });
    expect(ev.eventProperties).toEqual({});
    expect(ev.contactProperties).toBeUndefined();
  });
});

describe("webhookContactSource factory", () => {
  it("builds a match-auth source with the safe email-only cold posture", () => {
    const src = webhookContactSource({ id: "acme-crm", envKey: "ACME_SECRET" });
    expect(src.meta.id).toBe("acme-crm");
    expect(src.auth).toEqual({
      type: "match",
      header: "x-hogsend-secret",
      envKey: "ACME_SECRET",
    });
    expect(src.coldPosture).toEqual({ email: "allow" });
    expect(isColdChannelAllowed(src.coldPosture, "sms")).toBe(false);
  });

  it("honors a custom header and cold posture", () => {
    const src = webhookContactSource({
      id: "acme-crm",
      envKey: "ACME_SECRET",
      header: "x-acme-token",
      coldPosture: { discord: "allow" },
    });
    expect(src.auth).toMatchObject({ header: "x-acme-token" });
    expect(isColdChannelAllowed(src.coldPosture, "discord")).toBe(true);
  });

  it("transform validates + normalizes via the schema shape", async () => {
    const src = webhookContactSource({ id: "acme-crm", envKey: "ACME_SECRET" });
    const ev = await src.transform(
      { event: "prospect.sourced", email: "a@example.com" },
      // biome-ignore lint/suspicious/noExplicitAny: minimal ctx for a pure transform test
      {} as any,
    );
    expect(ev).toMatchObject({
      event: "prospect.sourced",
      userEmail: "a@example.com",
    });
  });
});
