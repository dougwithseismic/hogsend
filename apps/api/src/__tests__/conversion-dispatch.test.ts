import type { ConversionDispatchInput, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversionDispatches, conversions, userEvents } =
  await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  defineConversion,
  defineConversionDestination,
  deliverConversionDispatch,
  getConversionDestinations,
  ingestEvent,
} = await import("@hogsend/engine");

const RUN = `cdx-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;

const sent: ConversionDispatchInput[] = [];
let failNext = false;

const fakeDestination = defineConversionDestination({
  meta: { id: "fakedest", name: "Fake destination" },
  async send(input) {
    if (failNext) {
      failNext = false;
      throw new Error("platform 500");
    }
    sent.push(input);
    return { response: { ok: true } };
  },
});

const conversion = defineConversion({
  id: `${RUN}-sale`,
  trigger: { event: "crm.deal_sold" },
  destinations: ["fakedest"],
});

// dispatch task enqueue is fire-and-forget through the mock — deliveries in
// this test are driven directly via deliverConversionDispatch.
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
  conversions: [conversion],
  conversionDestinations: [fakeDestination],
  overrides: { hatchet: mockHatchet },
});
const { db, registry, hatchet, logger } = container;

afterAll(async () => {
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(eq(conversions.definitionId, `${RUN}-sale`));
  const ids = convRows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .delete(conversionDispatches)
      .where(inArray(conversionDispatches.conversionId, ids));
    await db.delete(conversions).where(inArray(conversions.id, ids));
  }
  const contactRows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  for (const row of contactRows) {
    await db.delete(userEvents).where(eq(userEvents.userId, row.id));
  }
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
});

async function pendingDispatches() {
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(eq(conversions.definitionId, `${RUN}-sale`));
  const ids = convRows.map((r) => r.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(conversionDispatches)
    .where(inArray(conversionDispatches.conversionId, ids));
}

describe("conversion dispatch", () => {
  it("creates one idempotent dispatch row per destination and enriches with recovered clicks", async () => {
    // 1) an attributed arrival (the click evidence) BEFORE the sale
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "campaign.arrived",
        userEmail: EMAIL,
        eventProperties: {
          fbclid: "FBCLID_XYZ",
          utm_source: "facebook",
          landing_page: "https://x.com/quote",
        },
        occurredAt: "2026-07-10T09:00:00.000Z",
        source: "inapp",
      },
    });
    // 2) the sale (server-side) fires the conversion + dispatch row
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "crm.deal_sold",
        userEmail: EMAIL,
        eventProperties: { crm: "fakecrm" },
        value: 17124,
        currency: "GBP",
        occurredAt: "2026-07-12T14:00:00.000Z",
        idempotencyKey: `${RUN}-sold`,
        source: "crm",
      },
    });

    const dispatches = await pendingDispatches();
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      destinationId: "fakedest",
      status: "pending",
    });

    // 3) deliver — the enriched payload carries value + click context
    const result = await deliverConversionDispatch({
      db,
      logger,
      dispatchId: dispatches[0]?.id as string,
      registry: getConversionDestinations(),
    });
    expect(result.status).toBe("delivered");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      definitionId: `${RUN}-sale`,
      triggerEvent: "crm.deal_sold",
      value: 17124,
      currency: "GBP",
      occurredAt: new Date("2026-07-12T14:00:00.000Z").getTime(),
      contact: { email: EMAIL },
      clicks: {
        clickIds: { fbclid: "FBCLID_XYZ" },
        clickAt: new Date("2026-07-10T09:00:00.000Z").getTime(),
        landingPage: "https://x.com/quote",
      },
    });
    expect(sent[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);

    // 4) delivered rows are not re-sent
    const again = await deliverConversionDispatch({
      db,
      logger,
      dispatchId: dispatches[0]?.id as string,
      registry: getConversionDestinations(),
    });
    expect(again.status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("a failed send stays pending (throws for the durable retry) with the SAME eventId", async () => {
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: "crm.deal_sold",
        userEmail: EMAIL,
        eventProperties: {},
        value: 100,
        currency: "GBP",
        idempotencyKey: `${RUN}-sold-2`,
        source: "crm",
      },
    });
    const dispatches = (await pendingDispatches()).filter(
      (d) => d.status === "pending",
    );
    expect(dispatches).toHaveLength(1);
    const dispatchId = dispatches[0]?.id as string;

    failNext = true;
    await expect(
      deliverConversionDispatch({
        db,
        logger,
        dispatchId,
        registry: getConversionDestinations(),
      }),
    ).rejects.toThrow(/platform 500/);

    const retried = await deliverConversionDispatch({
      db,
      logger,
      dispatchId,
      registry: getConversionDestinations(),
    });
    expect(retried.status).toBe("delivered");
    expect(sent[1]?.eventId).toBe(dispatches[0]?.eventId);
  });
});
