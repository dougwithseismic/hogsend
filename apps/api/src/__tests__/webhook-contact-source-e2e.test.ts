import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// The shared secret the generic source matches its header against.
process.env.SRC_SECRET = "s3cret-token";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, userEvents } = await import("@hogsend/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, webhookContactSource } = await import(
  "@hogsend/engine"
);

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
  contactSources: [
    webhookContactSource({ id: "acme-crm", envKey: "SRC_SECRET" }),
  ],
});
const app = createApp(container);
const { db } = container;

const RUN = `e2e-${Date.now()}`;
const EMAIL = `${RUN}-a@example.com`;
const EXTERNAL_ID = `${RUN}-crm-1`;
const IDEMPOTENCY_KEY = `${RUN}-row-42`;

function post(body: unknown, secret = "s3cret-token") {
  return app.request("/v1/webhooks/acme-crm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hogsend-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

const payload = {
  event: "prospect.sourced",
  email: EMAIL,
  external_id: EXTERNAL_ID,
  properties: { company: "Acme", title: "VP Growth" },
  idempotency_key: IDEMPOTENCY_KEY,
};

afterAll(async () => {
  await db.delete(userEvents).where(inArray(userEvents.userId, [EXTERNAL_ID]));
  await db.delete(contacts).where(inArray(contacts.email, [EMAIL]));
});

describe("generic webhook contact source — end-to-end", () => {
  it("rejects a bad shared secret", async () => {
    const res = await post(payload, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("creates a cold prospect with provenance + enrichment on a valid POST", async () => {
    const res = await post(payload);
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL))
      .limit(1);
    const row = rows[0];
    expect(row).toBeDefined();
    // Provenance stamped from the source id → this contact is a cold prospect.
    expect(row?.source).toBe("acme-crm");
    expect(row?.sourcedAt).toBeInstanceOf(Date);
    // Enrichment landed on contacts.properties.
    expect(row?.properties).toMatchObject({
      company: "Acme",
      title: "VP Growth",
    });
    // Classified as a prospect origin by the registry.
    expect(container.contactSourceRegistry.isProspectSource(row?.source)).toBe(
      true,
    );
  });

  it("is idempotent — a re-POST with the same idempotency_key does not re-ingest", async () => {
    const res = await post(payload);
    expect(res.status).toBe(200);

    const events = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, EXTERNAL_ID),
          eq(userEvents.idempotencyKey, IDEMPOTENCY_KEY),
        ),
      );
    // Exactly one user_events row despite two POSTs (onConflictDoNothing).
    expect(events).toHaveLength(1);

    // And no duplicate contact was minted.
    const dupes = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.email, EMAIL), eq(contacts.source, "acme-crm")));
    expect(dupes).toHaveLength(1);
  });
});
