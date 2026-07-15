/**
 * GET /v1/admin/flow × the base-currency lens (#496). Proves: with a
 * EUR-quoted static sheet, per-node revenue converts into
 * `heat.*RevenueBase` and the response carries `fx: { baseCurrency, asOf }`;
 * and the null-on-partial law — a node holding money in a currency with NO
 * rate reports base null (a partial sum would understate it) while its
 * per-currency truth still serves. Assertions stay on RUN-SCOPED surface
 * nodes only: the shared builtin `revenue` node pools other suites' events
 * in currencies this sheet can't convert.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
process.env.BASE_CURRENCY = "EUR";
process.env.FX_RATES = '{"CHF":1.04,"DKK":0.134}';
process.env.FX_RATES_AS_OF = "2026-07-01";

const { userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineSurface } = await import(
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

const RUN = `fxflow-${Date.now()}`;
const CLEAN_NODE = `surface:${RUN}clean`;
const MIXED_NODE = `surface:${RUN}mixed`;

const container = createHogsendClient({
  surfaces: [
    // Every event value here is convertible — base must be the exact sum.
    defineSurface({
      id: `${RUN}clean`,
      tier: "acquisition",
      match: { eventPrefix: `${RUN}.clean.` },
    }),
    // One event in a currency the sheet lacks — base must be NULL, never a
    // partial sum.
    defineSurface({
      id: `${RUN}mixed`,
      tier: "acquisition",
      match: { eventPrefix: `${RUN}.mixed.` },
    }),
  ],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

type FxFlowNode = {
  id: string;
  heat: {
    directRevenue: { amount: number; currency: string }[];
    directRevenueBase: number | null;
    attributedRevenueBase: number | null;
  } | null;
};
type FxFlowResponse = {
  nodes: FxFlowNode[];
  fx: { baseCurrency: string; asOf: string | null } | null;
};

let flow: FxFlowResponse;

beforeAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, "fxflow-%"));
  await db.insert(userEvents).values([
    // clean: 100 CHF + 50 DKK → base = 100×1.04 + 50×0.134 = 110.7 EUR
    {
      userId: `${RUN}-c1`,
      event: `${RUN}.clean.buy`,
      source: "test",
      value: 100,
      currency: "CHF",
    },
    {
      userId: `${RUN}-c2`,
      event: `${RUN}.clean.buy`,
      source: "test",
      value: 50,
      currency: "DKK",
    },
    // mixed: a convertible CHF + an XAU the sheet can't serve → base null.
    {
      userId: `${RUN}-m1`,
      event: `${RUN}.mixed.buy`,
      source: "test",
      value: 10,
      currency: "CHF",
    },
    {
      userId: `${RUN}-m2`,
      event: `${RUN}.mixed.buy`,
      source: "test",
      value: 1,
      currency: "XAU",
    },
  ]);

  const res = await app.request("/v1/admin/flow?windowDays=1&mode=curated", {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  flow = (await res.json()) as FxFlowResponse;
});

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  // The suite runs with fileParallelism:false (one shared process) — scrub
  // the env this file set so a file ordered after it never inherits the lens.
  delete process.env.BASE_CURRENCY;
  delete process.env.FX_RATES;
  delete process.env.FX_RATES_AS_OF;
});

const nodeOf = (id: string) => flow.nodes.find((n) => n.id === id);

describe("base-currency lens on the flow map", () => {
  it("carries the operator's lens in the response", () => {
    expect(flow.fx).toEqual({ baseCurrency: "EUR", asOf: "2026-07-01" });
  });

  it("converts a fully-convertible node into the base currency", () => {
    const heat = nodeOf(CLEAN_NODE)?.heat;
    expect(heat?.directRevenueBase).toBeCloseTo(110.7, 6);
    // No ledger credit seeded — measured, nothing there, still convertible.
    expect(heat?.attributedRevenueBase).toBe(0);
  });

  it("reports NULL (never a partial sum) when any currency lacks a rate", () => {
    const heat = nodeOf(MIXED_NODE)?.heat;
    expect(heat?.directRevenueBase).toBeNull();
    // The per-currency truth still serves in full.
    expect(heat?.directRevenue.length).toBe(2);
  });
});
