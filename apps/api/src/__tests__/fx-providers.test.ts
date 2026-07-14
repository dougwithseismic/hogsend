/**
 * Section 9.1b — the base-currency FX lens's rate sources. Unit-level, real
 * Postgres for the `fx_rates` cache (same docker DB as the other suites), NO
 * live network anywhere: the frankfurter provider takes an injected fetch.
 *
 * Proves: the static preset parses/serves the operator sheet (fail-LOUD on a
 * malformed one); the frankfurter preset inverts base→quote wire rates to
 * quote→base (1/N), upserts them into `fx_rates`, makes at most one fetch per
 * staleness window, serves the last cached sheet when a refetch fails, and
 * resolves null when cold + down; the lens injects base→base = 1 and holds
 * the fail-soft line even for a provider that throws.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  createFrankfurterFxProvider,
  createFxLens,
  createLogger,
  createStaticFxProvider,
  parseFxRatesEnv,
} = await import("@hogsend/engine");
const { createDatabase, fxRates } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL,
});

// Every base this suite writes under; swept before AND after so a crashed
// prior run never leaks staleness into the cache assertions.
const BASES = ["USD", "EUR", "CHF"];

const noopLogger = createLogger("error");

beforeAll(async () => {
  await db.delete(fxRates).where(inArray(fxRates.base, BASES));
});

afterAll(async () => {
  await db.delete(fxRates).where(inArray(fxRates.base, BASES));
  await client.end();
});

/** A fetch stub resolving Frankfurter's `/latest?from=<base>` shape. */
function fetchResolving(body: unknown): typeof fetch {
  return vi.fn(
    async () => ({ ok: true, json: async () => body }) as unknown as Response,
  ) as unknown as typeof fetch;
}

function fetchFailing(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

describe("parseFxRatesEnv / static provider", () => {
  it("parses the FX_RATES JSON and serves it with the given asOf", async () => {
    const rates = parseFxRatesEnv('{"JPY":0.0065,"GBP":1.27}');
    expect(rates).toEqual({ JPY: 0.0065, GBP: 1.27 });

    const provider = createStaticFxProvider({ rates, asOf: "2026-07-01" });
    expect(provider.meta.id).toBe("static");
    const sheet = await provider.getRates("USD");
    expect(sheet).toEqual({
      rates: { JPY: 0.0065, GBP: 1.27 },
      asOf: "2026-07-01",
    });
  });

  it("defaults asOf to null when the operator supplied no date", async () => {
    const provider = createStaticFxProvider({ rates: { JPY: 0.0065 } });
    const sheet = await provider.getRates("USD");
    expect(sheet?.asOf).toBeNull();
  });

  it("uppercases quote codes so rate lookups never miss on case", async () => {
    expect(parseFxRatesEnv('{"jpy":0.0065}')).toEqual({ JPY: 0.0065 });
    const provider = createStaticFxProvider({ rates: { gbp: 1.27 } });
    const sheet = await provider.getRates("USD");
    expect(sheet?.rates).toEqual({ GBP: 1.27 });
  });

  it("throws LOUD on malformed JSON — a typo'd sheet must fail boot", () => {
    expect(() => parseFxRatesEnv("{not json")).toThrow(/not valid JSON/);
    expect(() => parseFxRatesEnv('["JPY"]')).toThrow(/JSON object/);
  });

  it("throws on non-numeric / non-positive rates", () => {
    expect(() => parseFxRatesEnv('{"JPY":"0.0065"}')).toThrow(/positive/);
    expect(() => parseFxRatesEnv('{"JPY":0}')).toThrow(/positive/);
    expect(() => parseFxRatesEnv('{"JPY":-1}')).toThrow(/positive/);
  });
});

describe("frankfurter provider (mocked fetch, real fx_rates cache)", () => {
  it("inverts base→quote wire rates to quote→base, caches, and fetches at most once per window", async () => {
    // The wire says 1 USD = 155 JPY = 0.79 GBP; the lens wants quote→base.
    const fetchImpl = fetchResolving({
      amount: 1,
      base: "USD",
      date: "2026-07-10",
      rates: { JPY: 155, GBP: 0.79 },
    });
    const provider = createFrankfurterFxProvider({
      db,
      logger: noopLogger,
      fetchImpl,
    });

    const sheet = await provider.getRates("USD");
    expect(sheet?.asOf).toBe("2026-07-10");
    expect(sheet?.rates.JPY).toBeCloseTo(1 / 155, 10);
    expect(sheet?.rates.GBP).toBeCloseTo(1 / 0.79, 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.frankfurter.app/latest?from=USD",
    );

    // Pinned in the DB: one row per (base, quote), inverted, dated.
    const rows = await db
      .select()
      .from(fxRates)
      .where(inArray(fxRates.base, ["USD"]));
    expect(rows).toHaveLength(2);
    const jpy = rows.find((r) => r.quote === "JPY");
    expect(jpy?.rate).toBeCloseTo(1 / 155, 10);
    expect(jpy?.asOf).toBe("2026-07-10");

    // Second call inside the staleness window: served from the cache, the
    // network is NOT re-asked (≤1 outbound call per window).
    const again = await provider.getRates("USD");
    expect(again?.rates.JPY).toBeCloseTo(1 / 155, 10);
    expect(again?.asOf).toBe("2026-07-10");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches after the window and upserts in place (no history growth)", async () => {
    // maxAgeMs 0 forces every call stale; the wire moved to 1 USD = 160 JPY.
    const fetchImpl = fetchResolving({
      amount: 1,
      base: "USD",
      date: "2026-07-11",
      rates: { JPY: 160, GBP: 0.8 },
    });
    const provider = createFrankfurterFxProvider({
      db,
      logger: noopLogger,
      fetchImpl,
      maxAgeMs: 0,
    });

    const sheet = await provider.getRates("USD");
    expect(sheet?.rates.JPY).toBeCloseTo(1 / 160, 10);
    expect(sheet?.asOf).toBe("2026-07-11");

    // Still exactly one row per (base, quote) — updated, not appended.
    const rows = await db
      .select()
      .from(fxRates)
      .where(inArray(fxRates.base, ["USD"]));
    expect(rows).toHaveLength(2);
    const jpy = rows.find((r) => r.quote === "JPY");
    expect(jpy?.rate).toBeCloseTo(1 / 160, 10);
    expect(jpy?.asOf).toBe("2026-07-11");
  });

  it("serves the last cached sheet when a refetch fails (fail-soft, true asOf)", async () => {
    const fetchImpl = fetchFailing();
    const provider = createFrankfurterFxProvider({
      db,
      logger: noopLogger,
      fetchImpl,
      maxAgeMs: 0, // stale ⇒ it TRIES the network, which is down
    });

    const sheet = await provider.getRates("USD");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The 2026-07-11 sheet cached by the previous test, not an invention.
    expect(sheet?.rates.JPY).toBeCloseTo(1 / 160, 10);
    expect(sheet?.asOf).toBe("2026-07-11");
  });

  it("resolves null when cold AND down — never throws into a request path", async () => {
    const provider = createFrankfurterFxProvider({
      db,
      logger: noopLogger,
      fetchImpl: fetchFailing(),
    });
    // EUR has no cached rows: nothing to serve, nothing invented.
    await expect(provider.getRates("EUR")).resolves.toBeNull();
  });

  it("treats a malformed wire response as a failed fetch", async () => {
    const provider = createFrankfurterFxProvider({
      db,
      logger: noopLogger,
      fetchImpl: fetchResolving({ date: "2026-07-10", rates: {} }),
    });
    await expect(provider.getRates("CHF")).resolves.toBeNull();
  });
});

describe("createFxLens", () => {
  it("is OFF (null) without a base currency or provider", async () => {
    const off = createFxLens({ baseCurrency: null, logger: noopLogger });
    expect(off.baseCurrency).toBeNull();
    await expect(off.getRatesToBase()).resolves.toBeNull();

    const noSource = createFxLens({ baseCurrency: "USD", logger: noopLogger });
    await expect(noSource.getRatesToBase()).resolves.toBeNull();
  });

  it("injects the identity rate (base→base = 1) and carries the base", async () => {
    const lens = createFxLens({
      baseCurrency: "usd",
      provider: createStaticFxProvider({
        rates: { JPY: 0.0065 },
        asOf: "2026-07-01",
      }),
      logger: noopLogger,
    });
    expect(lens.baseCurrency).toBe("USD");
    const sheet = await lens.getRatesToBase();
    expect(sheet).toEqual({
      baseCurrency: "USD",
      rates: { JPY: 0.0065, USD: 1 },
      asOf: "2026-07-01",
    });
  });

  it("fail-softs a THROWING provider to null (the lens holds the line)", async () => {
    const lens = createFxLens({
      baseCurrency: "USD",
      provider: {
        meta: { id: "broken", name: "Broken" },
        getRates: async () => {
          throw new Error("boom");
        },
      },
      logger: noopLogger,
    });
    await expect(lens.getRatesToBase()).resolves.toBeNull();
  });
});
