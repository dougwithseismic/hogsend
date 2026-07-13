import { ATTRIBUTION_MODELS } from "@hogsend/attribution";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { attributionCredits, contacts, conversions, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConversion, ingestEvent } =
  await import("@hogsend/engine");

const RUN = `attr-${Date.now()}`;
const USER = `${RUN}-user`;
/** A converter with NO touchpoint path — lands in the unattributed bucket. */
const DIRECT_USER = `${RUN}-direct`;

const saleConversion = defineConversion({
  id: `${RUN}-sale`,
  trigger: { event: "deal.sold" },
  attributionWindowDays: 30,
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
  conversions: [saleConversion],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

afterAll(async () => {
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(eq(conversions.definitionId, `${RUN}-sale`));
  const ids = convRows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .delete(attributionCredits)
      .where(inArray(attributionCredits.conversionId, ids));
    await db.delete(conversions).where(inArray(conversions.id, ids));
  }
  await db
    .delete(userEvents)
    .where(inArray(userEvents.userId, [USER, DIRECT_USER]));
  await db
    .delete(contacts)
    .where(inArray(contacts.externalId, [USER, DIRECT_USER]));
});

const send = (opts: {
  event: string;
  at: string;
  source: string;
  value?: number;
  properties?: Record<string, unknown>;
  userId?: string;
}) => {
  const userId = opts.userId ?? USER;
  return ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: opts.event,
      userId,
      eventProperties: opts.properties ?? {},
      ...(opts.value !== undefined
        ? { value: opts.value, currency: "GBP" }
        : {}),
      occurredAt: opts.at,
      idempotencyKey: `${RUN}:${userId}:${opts.event}:${opts.at}`,
      source: opts.source,
    },
  });
};

describe("attribution credit ledger (6.1)", () => {
  it("writes every model's credits over the windowed touchpoint path when a conversion fires", async () => {
    // Outside the 30d window — must NOT be credited.
    await send({
      event: "campaign.arrived",
      at: "2026-05-01T09:00:00.000Z",
      source: "inapp",
      properties: { fbclid: "OLD" },
    });
    // The path: ad click → email click → lead form.
    await send({
      event: "campaign.arrived",
      at: "2026-07-01T09:00:00.000Z",
      source: "inapp",
      properties: { fbclid: "NEW" },
    });
    await send({
      event: "email.link_clicked",
      at: "2026-07-05T09:00:00.000Z",
      source: "tracking",
    });
    await send({
      event: "lead.submitted",
      at: "2026-07-08T09:00:00.000Z",
      source: "lead-form",
    });
    // The conversion (value £10,000).
    await send({
      event: "deal.sold",
      at: "2026-07-12T09:00:00.000Z",
      source: "crm",
      value: 10000,
    });

    const convRows = await db
      .select()
      .from(conversions)
      .where(eq(conversions.definitionId, `${RUN}-sale`));
    expect(convRows).toHaveLength(1);
    const credits = await db
      .select()
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, convRows[0]?.id as string));

    // Per model: weights sum to 1, values sum to the conversion value, and
    // the out-of-window touch is never credited.
    for (const model of ATTRIBUTION_MODELS) {
      const rows = credits.filter((c) => c.model === model);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(3);
      const weightSum = rows.reduce((s, r) => s + r.weight, 0);
      expect(weightSum).toBeCloseTo(1, 6);
      const valueSum = rows.reduce((s, r) => s + (r.value ?? 0), 0);
      expect(valueSum).toBeGreaterThan(9999);
      expect(valueSum).toBeLessThanOrEqual(10000.02);
      expect(rows.every((r) => r.touchpointAt >= new Date("2026-06-12"))).toBe(
        true,
      );
    }
    // Spot checks: first = the in-window ad click; lastNonDirect skips the
    // form and lands on the email click.
    const first = credits.find((c) => c.model === "first");
    expect(first).toMatchObject({ channel: "campaign", weight: 1 });
    const lastNonDirect = credits.find((c) => c.model === "lastNonDirect");
    expect(lastNonDirect).toMatchObject({ channel: "email", weight: 1 });

    // Replay: re-ingesting the sale dedups at the spine, so no double rows.
    await send({
      event: "deal.sold",
      at: "2026-07-12T09:00:00.000Z",
      source: "crm",
      value: 10000,
    });
    const again = await db
      .select()
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, convRows[0]?.id as string));
    expect(again.length).toBe(credits.length);
  });

  it("serves the model × channel rollup on GET /v1/admin/attribution", async () => {
    // A second conversion with NO touchpoint path — earns zero credits but
    // must still show up in the coverage totals as unattributed value.
    await send({
      event: "deal.sold",
      at: "2026-07-11T09:00:00.000Z",
      source: "crm",
      value: 5000,
      userId: DIRECT_USER,
    });

    const res = await app.request(
      `/v1/admin/attribution?days=365&definitionId=${RUN}-sale`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        model: string;
        channel: string;
        currency: string | null;
        value: number;
        conversions: number;
      }>;
      totals: Array<{
        currency: string | null;
        value: number;
        conversions: number;
        attributedValue: number;
        attributedConversions: number;
      }>;
    };
    const blended = body.rows.filter((r) => r.model === "blended");
    expect(blended.length).toBeGreaterThanOrEqual(2);
    const total = blended.reduce((s, r) => s + r.value, 0);
    expect(total).toBeGreaterThan(9999);
    expect(total).toBeLessThanOrEqual(10000.02);
    const firstRows = body.rows.filter((r) => r.model === "first");
    expect(firstRows).toEqual([
      expect.objectContaining({
        channel: "campaign",
        currency: "GBP",
        conversions: 1,
      }),
    ]);
    // Coverage: both conversions fired, only the touched one is attributed.
    expect(body.totals).toEqual([
      expect.objectContaining({
        currency: "GBP",
        value: 15000,
        conversions: 2,
        attributedValue: 10000,
        attributedConversions: 1,
      }),
    ]);
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/attribution");
    expect(res.status).toBe(401);
  });
});
