import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversionDispatches, conversions, userEvents } =
  await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

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
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const RUN = `adcv-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;

let contactId: string;
const conversionIds: string[] = [];

beforeAll(async () => {
  const [contact] = await db
    .insert(contacts)
    .values({ email: EMAIL, externalId: `${RUN}-user` })
    .returning({ id: contacts.id });
  contactId = contact?.id as string;

  const eventRows = await db
    .insert(userEvents)
    .values([
      {
        userId: `${RUN}-user`,
        event: "crm.deal_sold",
        properties: {},
        value: 17124,
        currency: "GBP",
        source: "crm",
      },
      {
        userId: `${RUN}-user`,
        event: "crm.deal_quoted",
        properties: {},
        value: 15900,
        currency: "GBP",
        source: "crm",
      },
    ])
    .returning({ id: userEvents.id });

  const conversionRows = await db
    .insert(conversions)
    .values([
      {
        definitionId: `${RUN}-sold`,
        contactId,
        userKey: `${RUN}-user`,
        eventId: eventRows[0]?.id as string,
        value: 17124,
        currency: "GBP",
        occurredAt: new Date(),
      },
      {
        definitionId: `${RUN}-quoted`,
        contactId,
        userKey: `${RUN}-user`,
        eventId: eventRows[1]?.id as string,
        value: 15900,
        currency: "GBP",
        occurredAt: new Date(),
      },
    ])
    .returning({ id: conversions.id, definitionId: conversions.definitionId });
  conversionIds.push(...conversionRows.map((r) => r.id));

  await db.insert(conversionDispatches).values([
    {
      conversionId: conversionRows[0]?.id as string,
      destinationId: `${RUN}-dest`,
      eventId: `${RUN}-evt-1`,
      status: "delivered",
      attempts: 1,
      deliveredAt: new Date(),
      response: { events_received: 1 },
    },
    {
      conversionId: conversionRows[1]?.id as string,
      destinationId: `${RUN}-dest`,
      eventId: `${RUN}-evt-2`,
      status: "failed",
      attempts: 5,
      lastError: "Meta CAPI 400: Invalid parameter",
    },
  ]);
});

afterAll(async () => {
  if (conversionIds.length > 0) {
    await db
      .delete(conversionDispatches)
      .where(inArray(conversionDispatches.conversionId, conversionIds));
    await db.delete(conversions).where(inArray(conversions.id, conversionIds));
  }
  await db.delete(userEvents).where(eq(userEvents.userId, `${RUN}-user`));
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
});

describe("admin conversions — delivery visibility", () => {
  it("lists conversions with contact email and per-destination dispatch state", async () => {
    const res = await app.request(
      `/v1/admin/conversions?definitionId=${RUN}-sold`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversions: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.conversions[0]).toMatchObject({
      definitionId: `${RUN}-sold`,
      contactEmail: EMAIL,
      value: 17124,
      currency: "GBP",
    });
    expect(body.conversions[0]?.dispatches).toEqual([
      expect.objectContaining({
        destinationId: `${RUN}-dest`,
        status: "delivered",
        attempts: 1,
      }),
    ]);
  });

  it("dispatchStatus filter narrows to failed deliveries (with the error)", async () => {
    const res = await app.request(
      `/v1/admin/conversions?definitionId=${RUN}-quoted&dispatchStatus=failed`,
      { headers: AUTH_HEADER },
    );
    const body = (await res.json()) as {
      conversions: Array<{
        dispatches: Array<{ status: string; lastError: string | null }>;
      }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.conversions[0]?.dispatches[0]).toMatchObject({
      status: "failed",
      lastError: "Meta CAPI 400: Invalid parameter",
    });

    const none = await app.request(
      `/v1/admin/conversions?definitionId=${RUN}-sold&dispatchStatus=failed`,
      { headers: AUTH_HEADER },
    );
    expect(((await none.json()) as { total: number }).total).toBe(0);
  });

  it("stats: per-definition counts + destination delivery health", async () => {
    const res = await app.request("/v1/admin/conversions/stats", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      definitions: Array<{ definitionId: string; count30d: number }>;
      destinations: Array<{
        destinationId: string;
        delivered: number;
        failed: number;
        pending: number;
      }>;
    };
    expect(
      body.definitions.find((d) => d.definitionId === `${RUN}-sold`)?.count30d,
    ).toBe(1);
    expect(
      body.destinations.find((d) => d.destinationId === `${RUN}-dest`),
    ).toMatchObject({ delivered: 1, failed: 1, pending: 0 });
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/conversions");
    expect(res.status).toBe(401);
  });
});
