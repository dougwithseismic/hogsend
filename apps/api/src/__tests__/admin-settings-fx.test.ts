/**
 * Section 9.4 — the base-currency Studio setting. Same harness as
 * admin-groups: `app.request()` directly against the Hono app, real Postgres
 * for `operator_settings` / `groups` / `user_events`, Hatchet injected via the
 * container override seam.
 *
 * Proves the `/v1/admin/settings/fx` surface end to end against the LIVE
 * precedence chain (no `fx.baseCurrency` pin — this suite drives env + the DB
 * row): with NO row the env `BASE_CURRENCY` decides; a PUT row WINS over env
 * (including `baseCurrency: null` = the explicit off); DELETE falls back to
 * env; a non-ISO code 400s. And THE STATIC-SHEET HONESTY RULE, asserted where
 * the money shows: a USD-quoted `FX_RATES` sheet serves the lens while the
 * effective base is USD, and serves NOTHING (groups list `fx` → null,
 * `revenueBase` → null) the moment the operator picks EUR — it must never
 * mis-multiply USD-quoted rates into another base.
 *
 * The `"fx"` operator-settings row is a SINGLETON in the shared docker DB (the
 * live demo API reads it per request), so beforeAll snapshots any existing row
 * and afterAll restores it exactly.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// The env bootstrap the setting overlays: a USD base served by a USD-quoted
// static sheet (1 JPY = 0.0065 USD). Set BEFORE the engine import — `env` is
// parsed at module load.
process.env.BASE_CURRENCY = "USD";
process.env.FX_RATES = '{"JPY":0.0065}';
process.env.FX_RATES_AS_OF = "2026-07-01";

const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { groups, operatorSettings, userEvents } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
  })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

// Deliberately NO `fx` container option: the provider comes from the env
// preset (static, quotedBase = env BASE_CURRENCY) and the base resolves
// per-request through the REAL setting → env chain this suite exercises.
const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// Run-scoped ids so parallel/crashed runs against the shared DB never collide.
const RUN = `asf-${Date.now()}`;
const FX_TYPE = `${RUN}-acct`;
const YEN_KEY = `${RUN}-yen-kk`;

/** The `"fx"` row is a singleton — snapshot whatever the live demo had. */
let priorFxValue: unknown;
let priorFxExisted = false;

beforeAll(async () => {
  const [row] = await db
    .select({ value: operatorSettings.value })
    .from(operatorSettings)
    .where(eq(operatorSettings.key, "fx"))
    .limit(1);
  priorFxExisted = row !== undefined;
  priorFxValue = row?.value;
  // Start from the documented baseline: NO row ⇒ env decides.
  await db.delete(operatorSettings).where(eq(operatorSettings.key, "fx"));

  // One group holding ¥100000 — the honesty rule's witness: converted to
  // $650 while the USD-quoted sheet serves, inconvertible under any other base.
  await db
    .insert(groups)
    .values({ groupType: FX_TYPE, groupKey: YEN_KEY, displayName: "Yen KK" });
  await db.insert(userEvents).values({
    userId: `${RUN}-user`,
    event: "deal.sold",
    value: 100000,
    currency: "JPY",
    groups: { [FX_TYPE]: YEN_KEY },
  });
});

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
  // Restore the singleton exactly as found so the live demo's lens is intact.
  await db.delete(operatorSettings).where(eq(operatorSettings.key, "fx"));
  if (priorFxExisted) {
    await db
      .insert(operatorSettings)
      .values({ key: "fx", value: priorFxValue });
  }
});

interface FxState {
  setting: { baseCurrency: string | null } | null;
  env: { baseCurrency: string | null };
  effective: { baseCurrency: string | null };
  provider: {
    id: string;
    asOf: string | null;
    servesEffectiveBase: boolean;
  } | null;
}

async function getFxState(): Promise<FxState> {
  const res = await app.request("/v1/admin/settings/fx", {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return await res.json();
}

async function putFx(baseCurrency: string | null): Promise<FxState> {
  const res = await app.request("/v1/admin/settings/fx", {
    method: "PUT",
    headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ baseCurrency }),
  });
  expect(res.status).toBe(200);
  return await res.json();
}

/** The groups list this suite watches for the lens's downstream effect. */
async function listYenGroup(): Promise<{
  groups: { groupKey: string; revenueBase: number | null }[];
  fx: { baseCurrency: string; asOf: string | null } | null;
}> {
  const res = await app.request(
    `/v1/admin/groups?groupType=${encodeURIComponent(FX_TYPE)}&limit=10`,
    { headers: AUTH_HEADER },
  );
  expect(res.status).toBe(200);
  return await res.json();
}

describe("GET/PUT/DELETE /v1/admin/settings/fx", () => {
  it("401s without auth", async () => {
    const res = await app.request("/v1/admin/settings/fx");
    expect(res.status).toBe(401);
    const put = await app.request("/v1/admin/settings/fx", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseCurrency: "EUR" }),
    });
    expect(put.status).toBe(401);
  });

  it("with NO row, reflects env: effective = BASE_CURRENCY, static sheet serves it", async () => {
    const state = await getFxState();
    expect(state.setting).toBeNull();
    expect(state.env).toEqual({ baseCurrency: "USD" });
    expect(state.effective).toEqual({ baseCurrency: "USD" });
    expect(state.provider).toEqual({
      id: "static",
      asOf: "2026-07-01",
      servesEffectiveBase: true,
    });

    // Downstream, the lens converts: ¥100000 × 0.0065 = $650, labeled.
    const list = await listYenGroup();
    expect(list.fx).toEqual({ baseCurrency: "USD", asOf: "2026-07-01" });
    expect(list.groups[0]?.revenueBase).toBeCloseTo(650, 6);
  });

  it("PUT EUR wins over env — and the USD-quoted sheet honestly serves NOTHING", async () => {
    // Lowercase in, ISO-normalized out.
    const state = await putFx("eur");
    expect(state.setting).toEqual({ baseCurrency: "EUR" });
    expect(state.env).toEqual({ baseCurrency: "USD" });
    expect(state.effective).toEqual({ baseCurrency: "EUR" });
    // THE HONESTY RULE, surfaced for the Studio card: the static sheet is
    // quoted in USD and must not serve (= mis-multiply into) an EUR base.
    expect(state.provider).toEqual({
      id: "static",
      asOf: null,
      servesEffectiveBase: false,
    });

    // …and where the money shows: no fx label, no converted figure. The
    // USD-quoted 0.0065 was NEVER applied to an EUR base.
    const list = await listYenGroup();
    expect(list.fx).toBeNull();
    expect(list.groups[0]?.revenueBase).toBeNull();
  });

  it("PUT null is the EXPLICIT off — it beats a set env BASE_CURRENCY", async () => {
    const state = await putFx(null);
    expect(state.setting).toEqual({ baseCurrency: null });
    expect(state.env).toEqual({ baseCurrency: "USD" });
    expect(state.effective).toEqual({ baseCurrency: null });

    const list = await listYenGroup();
    expect(list.fx).toBeNull();
    expect(list.groups[0]?.revenueBase).toBeNull();
  });

  it("DELETE clears the override — back to env, sheet serving again", async () => {
    const res = await app.request("/v1/admin/settings/fx", {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as FxState;
    expect(state.setting).toBeNull();
    expect(state.effective).toEqual({ baseCurrency: "USD" });
    expect(state.provider?.servesEffectiveBase).toBe(true);

    const list = await listYenGroup();
    expect(list.fx).toEqual({ baseCurrency: "USD", asOf: "2026-07-01" });
    expect(list.groups[0]?.revenueBase).toBeCloseTo(650, 6);

    // Idempotent: deleting the already-absent row still 200s with the same state.
    const again = await app.request("/v1/admin/settings/fx", {
      method: "DELETE",
      headers: AUTH_HEADER,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as FxState).effective.baseCurrency).toBe(
      "USD",
    );
  });

  it("rejects a non-ISO code with 400 and stores nothing", async () => {
    const res = await app.request("/v1/admin/settings/fx", {
      method: "PUT",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ baseCurrency: "EURO" }),
    });
    expect(res.status).toBe(400);
    // The reject wrote no row: still env-driven.
    const state = await getFxState();
    expect(state.setting).toBeNull();
    expect(state.effective).toEqual({ baseCurrency: "USD" });
  });
});
