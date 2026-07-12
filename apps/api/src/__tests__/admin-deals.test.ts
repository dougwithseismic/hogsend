import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, deals } = await import("@hogsend/db");
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
const RUN = `adld-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;

const contactIds: string[] = [];

afterAll(async () => {
  if (contactIds.length > 0) {
    await db.delete(deals).where(inArray(deals.contactId, contactIds));
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
});

async function seed() {
  const [contact] = await db
    .insert(contacts)
    .values({ email: EMAIL })
    .returning({ id: contacts.id });
  const contactId = contact?.id as string;
  contactIds.push(contactId);

  const now = new Date();
  await db.insert(deals).values([
    {
      provider: RUN,
      externalId: `${RUN}-sold-recent`,
      contactId,
      canonicalStage: "sold",
      stageRank: 4,
      value: 10000,
      currency: "GBP",
      soldAt: now,
      quotedAt: now,
      lastStageAt: now,
      // createdAt defaults to now → time-to-close ≈ 0h
    },
    {
      provider: RUN,
      externalId: `${RUN}-sold-old`,
      contactId,
      canonicalStage: "sold",
      stageRank: 4,
      value: 20000,
      currency: "GBP",
      soldAt: new Date("2026-01-01T00:00:00Z"),
      lastStageAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      provider: RUN,
      externalId: `${RUN}-open-quote`,
      contactId,
      canonicalStage: "quoted",
      stageRank: 3,
      value: 5000,
      currency: "GBP",
      quotedAt: now,
      lastStageAt: now,
    },
    {
      provider: RUN,
      externalId: `${RUN}-lost`,
      contactId,
      canonicalStage: "lost",
      stageRank: 0,
      value: 7000,
      currency: "GBP",
      lostAt: now,
      lastStageAt: now,
    },
  ]);
}

describe("admin deals ledger", () => {
  it("lists deals with stage + value filters and the contact email joined", async () => {
    await seed();
    const res = await app.request(
      `/v1/admin/deals?provider=${RUN}&stage=sold&minValue=15000`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deals: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.deals[0]).toMatchObject({
      externalId: `${RUN}-sold-old`,
      canonicalStage: "sold",
      value: 20000,
      currency: "GBP",
      contactEmail: EMAIL,
    });
  });

  it("stats: per-currency sold 30d vs lifetime, open pipeline excludes lost, AOV + cycle time", async () => {
    const res = await app.request("/v1/admin/deals/stats", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: Record<string, number>;
      currencies: Array<Record<string, unknown>>;
      avgTimeToCloseHours: number | null;
    };
    // Shared dev DB: assert at-least (other rows may exist), exact on GBP
    // block only when our RUN rows dominate is unsafe — instead find GBP and
    // check the invariants our seed guarantees.
    expect(body.stages.sold).toBeGreaterThanOrEqual(2);
    expect(body.stages.quoted).toBeGreaterThanOrEqual(1);
    expect(body.stages.lost).toBeGreaterThanOrEqual(1);
    const gbp = body.currencies.find((c) => c.currency === "GBP") as
      | Record<string, number>
      | undefined;
    expect(gbp).toBeDefined();
    if (!gbp) return;
    expect(gbp.soldRevenueLifetime).toBeGreaterThanOrEqual(30000);
    expect(gbp.soldRevenue30d).toBeGreaterThanOrEqual(10000);
    expect(gbp.soldRevenueLifetime).toBeGreaterThanOrEqual(gbp.soldRevenue30d);
    expect(gbp.openPipelineValue).toBeGreaterThanOrEqual(5000);
    expect(gbp.averageOrderValue).toBeGreaterThan(0);
    expect(body.avgTimeToCloseHours).not.toBeNull();
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/deals/stats");
    expect(res.status).toBe(401);
  });
});
