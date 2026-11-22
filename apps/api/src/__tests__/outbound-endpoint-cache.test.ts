import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// PRD 09 part B: the outbound spine reads its enabled endpoints from a cache
// (default 30 s) that the admin webhook routes clear. vitest.config sets
// OUTBOUND_ENDPOINT_CACHE_TTL_MS=0 for every other file; this one turns it on.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { webhookDeliveries, webhookEndpoints } = await import("@hogsend/db");
const { and, eq, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, emitOutbound } = await import(
  "@hogsend/engine"
);
const { countQueries } = await import("./query-counter.js");

const container = createHogsendClient();
const app = createApp(container);
const { db, dbClient, logger } = container;

const emitHatchet = {
  events: { push: vi.fn() },
} as unknown as Parameters<typeof emitOutbound>[0]["hatchet"];

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `oec-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let seq = 0;

afterEach(() => {
  process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS = "0";
});

afterAll(async () => {
  const rows = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(like(webhookEndpoints.url, `https://example.com/${RUN}/%`));
  for (const row of rows) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, row.id));
  }
  await db
    .delete(webhookEndpoints)
    .where(like(webhookEndpoints.url, `https://example.com/${RUN}/%`));
});

async function createEndpoint(label: string): Promise<string> {
  const res = await app.request("/v1/admin/webhooks", {
    method: "POST",
    headers: ADMIN_HEADER,
    body: JSON.stringify({
      url: `https://example.com/${RUN}/${label}`,
      eventTypes: ["contact.created"],
    }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  return json.id;
}

async function emitContactCreated(): Promise<void> {
  seq += 1;
  await emitOutbound({
    db,
    hatchet: emitHatchet,
    logger,
    event: "contact.created",
    dedupeKey: `${RUN}-${seq}`,
    payload: {
      id: "c-1",
      externalId: "ext-1",
      email: "a@b.com",
      properties: {},
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
}

async function deliveryCount(endpointId: string): Promise<number> {
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.eventType, "contact.created"),
      ),
    );
  return rows.length;
}

const readsEndpoints = (statements: { sql: string }[]) =>
  statements.filter((s) => /from "webhook_endpoints"/i.test(s.sql)).length;

describe("outbound endpoint cache", () => {
  it("reads webhook_endpoints once per TTL, not once per emit", async () => {
    process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS = "30000";
    await createEndpoint("count");

    const first = await countQueries(dbClient, emitContactCreated);
    const second = await countQueries(dbClient, emitContactCreated);

    expect(readsEndpoints(first.statements)).toBe(1);
    expect(readsEndpoints(second.statements)).toBe(0);
  });

  it("serves a cached list until an admin write clears it", async () => {
    process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS = "30000";
    const id = await createEndpoint("invalidate");

    await emitContactCreated();
    expect(await deliveryCount(id)).toBe(1);

    // A write that bypasses the admin routes is not seen inside the TTL.
    await db
      .update(webhookEndpoints)
      .set({ eventTypes: [] })
      .where(eq(webhookEndpoints.id, id));
    await emitContactCreated();
    expect(await deliveryCount(id)).toBe(2);

    // The admin PATCH clears the cache, so the next emit skips the endpoint.
    const res = await app.request(`/v1/admin/webhooks/${id}`, {
      method: "PATCH",
      headers: ADMIN_HEADER,
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(200);
    await emitContactCreated();
    expect(await deliveryCount(id)).toBe(2);
  });

  it("a cached endpoint deleted elsewhere does not cost the others their delivery", async () => {
    process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS = "30000";
    const gone = await createEndpoint("fk-gone");
    const kept = await createEndpoint("fk-kept");
    await emitContactCreated();
    expect(await deliveryCount(kept)).toBe(1);

    // Another instance deleted `gone`; this process still has it cached, so
    // the multi-row insert hits the foreign key and must retry without it.
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, gone));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, gone));
    await emitContactCreated();
    expect(await deliveryCount(kept)).toBe(2);
  });

  it("sees direct writes immediately with the cache off", async () => {
    process.env.OUTBOUND_ENDPOINT_CACHE_TTL_MS = "0";
    const id = await createEndpoint("off");

    await emitContactCreated();
    expect(await deliveryCount(id)).toBe(1);

    await db
      .update(webhookEndpoints)
      .set({ disabled: true })
      .where(eq(webhookEndpoints.id, id));
    await emitContactCreated();
    expect(await deliveryCount(id)).toBe(1);
  });
});
