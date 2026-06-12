import { describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { posthogDestination } = await import("@hogsend/engine");
const { webhookEndpoints } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");

type Envelope = Parameters<typeof posthogDestination.transform>[0];
type Ctx = Parameters<typeof posthogDestination.transform>[1];

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Ctx["logger"];

function ctxWith(config: Record<string, unknown>): Ctx {
  return {
    endpoint: { url: "posthog://capture", config } as Ctx["endpoint"],
    logger,
  };
}

function contactEnvelope(
  type: string,
  data: Record<string, unknown>,
): Envelope {
  return {
    id: "evt_1",
    type,
    timestamp: "2026-06-12T12:00:00.000Z",
    data,
  } as unknown as Envelope;
}

describe("posthog preset — person sync (contact.* → $set)", () => {
  const CONTACT = {
    id: "8b6f2c44-0000-0000-0000-000000000001",
    externalId: null as string | null,
    email: "ada@example.com",
    properties: { plan: "pro", role: "engineer" },
  };

  it("SKIPS contact.* entirely when syncPersons is off (no PII fallback capture)", () => {
    const result = posthogDestination.transform(
      contactEnvelope("contact.updated", CONTACT),
      ctxWith({ apiKey: "phc_x" }),
    );
    expect(result).toBeNull();
  });

  it("contact.updated → $set of contact.properties under the canonical key (id when externalId is null)", () => {
    const result = posthogDestination.transform(
      contactEnvelope("contact.updated", CONTACT),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    expect(result).not.toBeNull();
    const body = JSON.parse((result as { body: string }).body);
    expect(body.event).toBe("$set");
    expect(body.distinct_id).toBe(CONTACT.id);
    expect(body.properties.$set).toEqual({ plan: "pro", role: "engineer" });
    expect(body.properties.$lib).toBe("hogsend");
    // Privacy: the email must never travel.
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
  });

  it("prefers externalId as the distinct id when present", () => {
    const result = posthogDestination.transform(
      contactEnvelope("contact.created", { ...CONTACT, externalId: "u_42" }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    const body = JSON.parse((result as { body: string }).body);
    expect(body.distinct_id).toBe("u_42");
  });

  it("skips an empty properties bag (nothing to propagate)", () => {
    const result = posthogDestination.transform(
      contactEnvelope("contact.created", { ...CONTACT, properties: {} }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    expect(result).toBeNull();
  });

  it("contact.unsubscribed scope=all with externalId → hogsend_unsubscribed flag; category/keyless skip", () => {
    const full = posthogDestination.transform(
      contactEnvelope("contact.unsubscribed", {
        externalId: "u_42",
        email: null,
        category: null,
        scope: "all",
      }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    const body = JSON.parse((full as { body: string }).body);
    expect(body.properties.$set).toEqual({ hogsend_unsubscribed: true });

    const category = posthogDestination.transform(
      contactEnvelope("contact.unsubscribed", {
        externalId: "u_42",
        email: null,
        category: "marketing",
        scope: "category",
      }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    expect(category).toBeNull();

    const keyless = posthogDestination.transform(
      contactEnvelope("contact.unsubscribed", {
        externalId: null,
        email: "ada@example.com",
        category: null,
        scope: "all",
      }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    expect(keyless).toBeNull();
  });

  it("contact.deleted always skips (person deletion is a private-API op)", () => {
    const result = posthogDestination.transform(
      contactEnvelope("contact.deleted", {
        id: CONTACT.id,
        externalId: "u_42",
        email: null,
      }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    expect(result).toBeNull();
  });

  it("email.* events are untouched by the person-sync branch", () => {
    const result = posthogDestination.transform(
      contactEnvelope("email.opened", {
        emailSendId: "es_1",
        userId: "u_42",
        to: "ada@example.com",
      }),
      ctxWith({ apiKey: "phc_x", syncPersons: true }),
    );
    const body = JSON.parse((result as { body: string }).body);
    expect(body.event).toBe("email.opened");
    expect(body.distinct_id).toBe("u_42");
  });
});

describe("seedPostHogDestination — person-sync reconcile", () => {
  it("seeds with person-sync events + syncPersons, and reconciles a pre-upgrade row", async () => {
    const { createHogsendClient, seedPostHogDestination } = await import(
      "@hogsend/engine"
    );
    const mod = { seedPostHogDestination };
    const container = createHogsendClient();
    const { db } = container;

    // Clean slate for the sentinel row.
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.url, "posthog://capture"));

    await db.insert(webhookEndpoints).values({
      url: "posthog://capture",
      description: "pre-upgrade seeded row",
      kind: "posthog",
      config: { apiKey: "phc_x" },
      eventTypes: ["email.sent", "email.delivered"],
      secret: null,
      secretPrefix: null,
      disabled: false,
    });

    const result = await mod.seedPostHogDestination({
      db,
      logger: container.logger,
      apiKey: "phc_x",
    });
    expect(result.seeded).toBe(false); // found + reconciled, not re-seeded

    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.url, "posthog://capture"));
    const types = row?.eventTypes as string[];
    expect(types).toContain("contact.created");
    expect(types).toContain("contact.updated");
    expect(types).toContain("contact.unsubscribed");
    expect(types).toContain("email.opened"); // funnel gap also reconciled
    expect((row?.config as { syncPersons?: boolean }).syncPersons).toBe(true);

    // An explicit operator `false` is NEVER overridden.
    await db
      .update(webhookEndpoints)
      .set({ config: { apiKey: "phc_x", syncPersons: false } })
      .where(eq(webhookEndpoints.url, "posthog://capture"));
    await mod.seedPostHogDestination({
      db,
      logger: container.logger,
      apiKey: "phc_x",
    });
    const [after] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.url, "posthog://capture"));
    expect((after?.config as { syncPersons?: boolean }).syncPersons).toBe(
      false,
    );

    // Cleanup.
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.url, "posthog://capture"));
    await container.dbClient.end({ timeout: 5 }).catch(() => {});
  });
});
