import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, deals } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");
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
      providers: string[];
    };
    // The distinct-provider vocabulary includes our seeded provider.
    expect(body.providers).toContain(RUN);
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
    expect(gbp.soldRevenueLifetime).toBeGreaterThanOrEqual(
      gbp.soldRevenue30d ?? 0,
    );
    expect(gbp.openPipelineValue).toBeGreaterThanOrEqual(5000);
    expect(gbp.averageOrderValue).toBeGreaterThan(0);
    expect(body.avgTimeToCloseHours).not.toBeNull();
  });

  it("search filters by contact email; timeseries buckets sold revenue by day", async () => {
    const bySearch = await app.request(
      `/v1/admin/deals?provider=${RUN}&search=${encodeURIComponent(RUN)}`,
      { headers: AUTH_HEADER },
    );
    expect(bySearch.status).toBe(200);
    const searchBody = (await bySearch.json()) as { total: number };
    expect(searchBody.total).toBe(4);
    const miss = await app.request(
      `/v1/admin/deals?provider=${RUN}&search=nobody-matches-this`,
      { headers: AUTH_HEADER },
    );
    expect(((await miss.json()) as { total: number }).total).toBe(0);

    const ts = await app.request("/v1/admin/deals/timeseries?days=30", {
      headers: AUTH_HEADER,
    });
    expect(ts.status).toBe(200);
    const tsBody = (await ts.json()) as {
      days: number;
      revenue: Array<{
        currency: string | null;
        points: Array<{ date: string; value: number }>;
      }>;
      counts: {
        sold: Array<{ date: string; value: number }>;
        quoted: Array<{ date: string; value: number }>;
        created: Array<{ date: string; value: number }>;
      };
    };
    expect(tsBody.days).toBe(30);
    const gbpSeries = tsBody.revenue.find((c) => c.currency === "GBP");
    // The recent sold deal (today UTC, £10k) must appear in today's bucket;
    // the January one is outside the window.
    const today = new Date().toISOString().slice(0, 10);
    const todayPoint = gbpSeries?.points.find((p) => p.date === today);
    expect(todayPoint?.value).toBeGreaterThanOrEqual(10000);
    expect(
      gbpSeries?.points.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date)),
    ).toBe(true);
    // Activity counts: today has at least our sold + quoted + created seeds.
    expect(
      tsBody.counts.sold.find((p) => p.date === today)?.value,
    ).toBeGreaterThanOrEqual(1);
    expect(
      tsBody.counts.quoted.find((p) => p.date === today)?.value,
    ).toBeGreaterThanOrEqual(2);
    expect(
      tsBody.counts.created.find((p) => p.date === today)?.value,
    ).toBeGreaterThanOrEqual(4);
  });

  it("sorts by whitelisted columns and serves reached funnel counts", async () => {
    const byValue = await app.request(
      `/v1/admin/deals?provider=${RUN}&sort=value&dir=desc`,
      { headers: AUTH_HEADER },
    );
    const valueBody = (await byValue.json()) as {
      deals: Array<{ value: number | null }>;
    };
    const values = valueBody.deals.map((d) => d.value ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));

    const stats = await app.request("/v1/admin/deals/stats", {
      headers: AUTH_HEADER,
    });
    const statsBody = (await stats.json()) as {
      stageOrder: string[];
      reached: Record<string, number>;
    };
    // Reached counts are non-increasing down the ladder (a TRUE funnel) and
    // sold-reached covers our two sold seeds.
    const ladder = statsBody.stageOrder.filter((s) => s !== "lost");
    for (let i = 1; i < ladder.length; i++) {
      const prev = statsBody.reached[ladder[i - 1] as string] ?? 0;
      const curr = statsBody.reached[ladder[i] as string] ?? 0;
      expect(curr).toBeLessThanOrEqual(prev);
    }
    expect(statsBody.reached.sold).toBeGreaterThanOrEqual(2);
  });

  it("requires admin auth", async () => {
    const res = await app.request("/v1/admin/deals/stats");
    expect(res.status).toBe(401);
  });

  it("contacts long-tail filter: dealStage=sold + minRevenue narrows to value customers", async () => {
    // Our seeded contact has sold deals but NO valued events — dealStage
    // filter must find it, minRevenue must exclude it.
    const byStage = await app.request(
      `/v1/admin/contacts?dealStage=sold&search=${encodeURIComponent(EMAIL)}`,
      { headers: AUTH_HEADER },
    );
    expect(byStage.status).toBe(200);
    const stageBody = (await byStage.json()) as {
      contacts: Array<{ email: string | null }>;
    };
    expect(stageBody.contacts.some((c) => c.email === EMAIL)).toBe(true);

    const byRevenue = await app.request(
      `/v1/admin/contacts?minRevenue=1&search=${encodeURIComponent(EMAIL)}`,
      { headers: AUTH_HEADER },
    );
    expect(byRevenue.status).toBe(200);
    const revenueBody = (await byRevenue.json()) as {
      contacts: Array<{ email: string | null }>;
    };
    expect(revenueBody.contacts.some((c) => c.email === EMAIL)).toBe(false);

    const byLostStage = await app.request(
      `/v1/admin/contacts?dealStage=contacted&search=${encodeURIComponent(EMAIL)}`,
      { headers: AUTH_HEADER },
    );
    const lostBody = (await byLostStage.json()) as {
      contacts: Array<{ email: string | null }>;
    };
    expect(lostBody.contacts.some((c) => c.email === EMAIL)).toBe(false);
  });
});
