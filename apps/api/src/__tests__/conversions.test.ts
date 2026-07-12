import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversions, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConversion, ingestEvent } =
  await import("@hogsend/engine");

const RUN = `cnv-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;
const USER = `${RUN}-user`;

const saleConversion = defineConversion({
  id: `${RUN}-sale`,
  name: "Deal sold",
  trigger: { event: "crm.deal_sold" },
  // default sources (server-side only), default value (the event's value)
});

const bigQuoteConversion = defineConversion({
  id: `${RUN}-big-quote`,
  trigger: {
    event: "crm.deal_quoted",
    where: (b) => b.prop("crm").eq("fakecrm"),
  },
  value: { source: "fixed", amount: 50, currency: "gbp" },
});

const browserConversion = defineConversion({
  id: `${RUN}-browser-ok`,
  trigger: { event: `${RUN}.checkout` },
  sources: "any",
});

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

const container = createHogsendClient({
  conversions: [saleConversion, bigQuoteConversion, browserConversion],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

afterAll(async () => {
  await db
    .delete(conversions)
    .where(
      inArray(conversions.definitionId, [
        `${RUN}-sale`,
        `${RUN}-big-quote`,
        `${RUN}-browser-ok`,
      ]),
    );
  await db.delete(userEvents).where(eq(userEvents.userId, USER));
  await db.delete(contacts).where(eq(contacts.externalId, USER));
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
});

async function firedFor(definitionId: string) {
  return db
    .select()
    .from(conversions)
    .where(eq(conversions.definitionId, definitionId));
}

describe("conversion points at ingest", () => {
  it("fires a valued conversion off a server-side event and is idempotent", async () => {
    const ingest = () =>
      ingestEvent({
        db,
        registry,
        hatchet,
        logger,
        event: {
          event: "crm.deal_sold",
          userId: USER,
          eventProperties: { crm: "fakecrm", deal_id: "d1" },
          value: 17124,
          currency: "GBP",
          occurredAt: "2026-07-12T14:00:00.000Z",
          idempotencyKey: `${RUN}-sold-1`,
          source: "crm",
        },
      });
    await ingest();
    await ingest(); // spine dedup → no second evaluation

    const fired = await firedFor(`${RUN}-sale`);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      userKey: USER,
      value: 17124,
      currency: "GBP",
    });
    expect(fired[0]?.occurredAt.toISOString()).toBe("2026-07-12T14:00:00.000Z");
  });

  it("applies where conditions and fixed values", async () => {
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "crm.deal_quoted",
        userId: USER,
        eventProperties: { crm: "othercrm" },
        source: "crm",
      },
    });
    expect(await firedFor(`${RUN}-big-quote`)).toHaveLength(0);

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "crm.deal_quoted",
        userId: USER,
        eventProperties: { crm: "fakecrm" },
        source: "crm",
      },
    });
    const fired = await firedFor(`${RUN}-big-quote`);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ value: 50, currency: "GBP" });
  });

  it("the forged-value guard: default definitions ignore browser (inapp) events; sources:'any' opts in", async () => {
    // Browser-tier event claiming a sale value — must NOT fire the default
    // sale conversion (different event anyway), so aim it at a default-guard
    // clone via the public route with a pk-less secret-key... simpler: direct
    // ingest with source "inapp".
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "crm.deal_sold",
        userId: USER,
        eventProperties: {},
        value: 999999,
        source: "inapp",
      },
    });
    // Still just the one fired sale conversion from the first test.
    expect(await firedFor(`${RUN}-sale`)).toHaveLength(1);

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.checkout`,
        userId: USER,
        eventProperties: {},
        value: 49,
        currency: "USD",
        source: "inapp",
      },
    });
    const fired = await firedFor(`${RUN}-browser-ok`);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ value: 49, currency: "USD" });
  });

  it("fires through the public /v1/events route end-to-end", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "crm.deal_sold",
        userId: USER,
        value: 5000,
        currency: "GBP",
      }),
    });
    expect(res.status).toBe(202);
    // Route source is "api" (server-side) → allowed by the default guard.
    expect(await firedFor(`${RUN}-sale`)).toHaveLength(2);
  });
});
