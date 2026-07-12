import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, ingestEvent } = await import(
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
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `evv-${Date.now()}`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.event, `${RUN}.event`));
  for (const suffix of ["a", "b", "c", "d"]) {
    await db
      .delete(contacts)
      .where(eq(contacts.externalId, `${RUN}-${suffix}`));
  }
});

async function lastEventFor(userId: string) {
  const rows = await db
    .select()
    .from(userEvents)
    .where(eq(userEvents.userId, userId));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

describe("event value/currency — the revenue spine", () => {
  it("stores value + uppercased currency as first-class columns, not properties", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: `${RUN}.event`,
        userId: `${RUN}-a`,
        value: 13302.5,
        currency: "gbp",
        eventProperties: { product: "solar" },
      }),
    });
    expect(res.status).toBe(202);
    const row = await lastEventFor(`${RUN}-a`);
    expect(row?.value).toBe(13302.5);
    expect(row?.currency).toBe("GBP");
    expect(row?.properties).toEqual({ product: "solar" });
  });

  it("stores nulls when no value is sent; drops currency without value", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: `${RUN}.event`,
        userId: `${RUN}-b`,
        currency: "USD",
      }),
    });
    expect(res.status).toBe(202);
    const row = await lastEventFor(`${RUN}-b`);
    expect(row?.value).toBeNull();
    expect(row?.currency).toBeNull();
  });

  it("rejects a non-3-letter currency at the route boundary", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: `${RUN}.event`,
        userId: `${RUN}-c`,
        value: 10,
        currency: "pounds",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("ingestEvent (webhook-source path) is permissive: malformed currency drops, value survives; negative values (refunds) store", async () => {
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.event`,
        userId: `${RUN}-d`,
        eventProperties: {},
        value: -250,
        currency: "quid",
      },
    });
    const row = await lastEventFor(`${RUN}-d`);
    expect(row?.value).toBe(-250);
    expect(row?.currency).toBeNull();
  });
});
