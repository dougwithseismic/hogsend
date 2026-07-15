import type { FxRateProvider, FxRateSheet } from "@hogsend/core";
import { defineFxRateProvider } from "@hogsend/core";
import type { Database } from "@hogsend/db";
import { fxRates } from "@hogsend/db";
import { eq, sql } from "drizzle-orm";
import type { env as envSchema } from "../env.js";
import type { Logger } from "./logger.js";

/**
 * The base-currency FX lens (docs/groups.md §Base-currency lens) — an OPT-IN
 * converted VIEW layered on top of the revenue spine's per-currency truth.
 * The law (`lib/revenue.ts`) is untouched: currencies are never summed
 * together; the lens converts each per-currency total through an operator-
 * sanctioned quote→base rate and sums the CONVERSIONS. Off by default — the
 * effective base resolves per call (Studio operator setting → env
 * `BASE_CURRENCY`; see the container's resolver); when neither is set the
 * lens resolves null everywhere and nothing changes.
 *
 * Two shipped presets, mirroring how analytics builds from env
 * (`analyticsProvidersFromEnv`), except there is deliberately NO registry:
 * exactly one rate source is resolved at boot (lean-first — multiple
 * simultaneous FX sources have no use case). A consumer-supplied provider
 * (`fx.provider`) wins over both presets.
 *
 *  - `static` (the DEFAULT) — sovereign, zero network: the operator supplies
 *    the rates (`FX_RATES` JSON) and optionally their date (`FX_RATES_AS_OF`).
 *  - `frankfurter` (OPT-IN via `FX_PROVIDER=frankfurter`) — ECB daily
 *    reference rates, cached in `fx_rates` so conversions are pinned to a
 *    recorded sheet and the API is hit at most once per staleness window.
 */

/** How long a fetched sheet serves before the network source is re-asked. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Static preset (the default — operator-supplied rates, zero network)
// ---------------------------------------------------------------------------

/**
 * Parse the `FX_RATES` env JSON into a quote→rate map. THROWS on anything
 * malformed (bad JSON, non-object, non-finite or non-positive rates) — a
 * typo'd rate sheet must fail the boot loudly, never silently convert money
 * wrong (the same fail-loud posture as an unresolvable `EMAIL_PROVIDER`).
 * Keys are uppercased so lookups never miss on case.
 */
export function parseFxRatesEnv(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'FX_RATES is not valid JSON — expected e.g. {"JPY":0.0065,"GBP":1.27}',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      'FX_RATES must be a JSON object of quote→base rates, e.g. {"JPY":0.0065}',
    );
  }
  const rates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(parsed)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `FX_RATES["${code}"] must be a positive number (got ${JSON.stringify(rate)})`,
      );
    }
    rates[code.toUpperCase()] = rate;
  }
  return rates;
}

/**
 * The sovereign default rate source: a fixed operator-supplied sheet, which
 * is exactly the sovereignty trade: no network, no drift, rates change only
 * when the operator changes them.
 *
 * THE HONESTY RULE: a static sheet is only meaningful against the ONE base
 * it was quoted in (`quotedBase` — the env `BASE_CURRENCY` the operator's
 * `FX_RATES` were written for). `getRates(base)` serves the sheet ONLY when
 * `base === quotedBase` and resolves null for any other base — a USD-quoted
 * sheet must never silently convert into EUR just because the effective base
 * changed (e.g. via the Studio setting). A `quotedBase` of null (FX_RATES
 * with no BASE_CURRENCY) is a base-less sheet: it serves null for EVERY
 * base — inert, warned at boot in {@link fxProviderFromEnv}.
 */
export function createStaticFxProvider(opts: {
  rates: Record<string, number>;
  asOf?: string | null;
  /** The base the sheet's rates are quoted against (null = base-less/inert). */
  quotedBase: string | null;
}): FxRateProvider {
  const rates = Object.fromEntries(
    Object.entries(opts.rates).map(([code, rate]) => [
      code.toUpperCase(),
      rate,
    ]),
  );
  const asOf = opts.asOf ?? null;
  const quotedBase = opts.quotedBase?.toUpperCase() ?? null;
  return defineFxRateProvider({
    meta: {
      id: "static",
      name: "Static (operator-supplied rates)",
    },
    async getRates(base) {
      if (!quotedBase || base.toUpperCase() !== quotedBase) return null;
      return { rates: { ...rates }, asOf };
    },
  });
}

// ---------------------------------------------------------------------------
// Frankfurter preset (opt-in — ECB daily reference rates, DB-cached)
// ---------------------------------------------------------------------------

/** The subset of Frankfurter's `/latest` response the provider reads. */
interface FrankfurterLatest {
  date?: string;
  rates?: Record<string, unknown>;
}

/**
 * ECB daily reference rates via frankfurter.app, opt-in
 * (`FX_PROVIDER=frankfurter`). ONE request serves every quote:
 * `latest?from=<base>` returns base→quote rates (1 base = N quote) for all
 * supported currencies, which we INVERT (quote→base = 1/N) — there is no
 * `latest?to=<base>` batch form.
 *
 * Every successful fetch is upserted into `fx_rates`, and the cache is
 * authoritative until it goes stale, so the API sees at most one call per
 * staleness window and a day's conversions are pinned to one recorded sheet.
 * Staleness is measured from `fetched_at`, NOT `as_of`: the ECB reference
 * date legitimately freezes over weekends/holidays, so keying the refetch off
 * `as_of` would re-hit the API on every request all weekend for rates that
 * cannot have changed.
 *
 * FAIL-SOFT throughout: a failed/malformed fetch serves the last cached sheet
 * when one exists, else resolves null. Nothing here ever throws into a
 * request path.
 */
export function createFrankfurterFxProvider(opts: {
  db: Database;
  logger?: Logger;
  /** Test seam — injected fetch. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Refetch window in ms. Defaults to 24h (ECB publishes daily). */
  maxAgeMs?: number;
}): FxRateProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const sheetFromRows = (
    rows: (typeof fxRates.$inferSelect)[],
  ): FxRateSheet => ({
    rates: Object.fromEntries(rows.map((r) => [r.quote, Number(r.rate)])),
    // Rows are upserted as one batch, but be defensive: label the sheet with
    // the newest date present.
    asOf: rows.reduce<string | null>(
      (max, r) => (max === null || r.asOf > max ? r.asOf : max),
      null,
    ),
  });

  return defineFxRateProvider({
    meta: {
      id: "frankfurter",
      name: "Frankfurter (ECB daily reference rates)",
    },
    async getRates(base) {
      const baseCode = base.toUpperCase();
      let cached: (typeof fxRates.$inferSelect)[] = [];
      try {
        cached = await opts.db
          .select()
          .from(fxRates)
          .where(eq(fxRates.base, baseCode));

        const newestFetch = cached.reduce<number>(
          (max, r) => Math.max(max, r.fetchedAt.getTime()),
          0,
        );
        if (cached.length > 0 && Date.now() - newestFetch < maxAgeMs) {
          return sheetFromRows(cached);
        }

        const res = await fetchImpl(
          `https://api.frankfurter.app/latest?from=${encodeURIComponent(baseCode)}`,
        );
        if (!res.ok) {
          throw new Error(`frankfurter responded ${res.status}`);
        }
        const body = (await res.json()) as FrankfurterLatest;
        const asOf = body.date;
        // 1 base = N quote on the wire; the lens wants quote→base, so 1/N.
        const entries = Object.entries(body.rates ?? {}).filter(
          (pair): pair is [string, number] =>
            typeof pair[1] === "number" &&
            Number.isFinite(pair[1]) &&
            pair[1] > 0,
        );
        if (!asOf || entries.length === 0) {
          throw new Error("frankfurter returned no usable rates");
        }
        const fetchedAt = new Date();
        const rows = entries.map(([quote, perBase]) => ({
          base: baseCode,
          quote: quote.toUpperCase(),
          rate: 1 / perBase,
          asOf,
          fetchedAt,
        }));
        await opts.db
          .insert(fxRates)
          .values(rows)
          .onConflictDoUpdate({
            target: [fxRates.base, fxRates.quote],
            set: {
              rate: sql`excluded.rate`,
              asOf: sql`excluded.as_of`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          });
        return {
          rates: Object.fromEntries(rows.map((r) => [r.quote, r.rate])),
          asOf,
        };
      } catch (error) {
        // Fail-soft: a stale sheet labeled with its true asOf beats no sheet;
        // no sheet beats an invented one. Never throw into a request path.
        opts.logger?.warn(
          `frankfurter FX rates unavailable${
            cached.length > 0 ? " — serving the last cached sheet" : ""
          }`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        return cached.length > 0 ? sheetFromRows(cached) : null;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Env resolution + the lens (what the container holds)
// ---------------------------------------------------------------------------

/**
 * Resolve the ONE env-configured rate source, mirroring the env-preset spirit
 * of `analyticsProvidersFromEnv` without the registry: `FX_PROVIDER=
 * frankfurter` opts into the network source; otherwise a set `FX_RATES`
 * builds the sovereign static sheet (throwing at boot on a malformed one);
 * otherwise there is no source. A consumer `fx.provider` wins over this
 * entirely (checked at the container call site).
 */
export function fxProviderFromEnv(
  env: typeof envSchema,
  deps: { db: Database; logger?: Logger },
): FxRateProvider | undefined {
  if (env.FX_PROVIDER === "frankfurter") {
    return createFrankfurterFxProvider({ db: deps.db, logger: deps.logger });
  }
  if (env.FX_RATES) {
    if (!env.BASE_CURRENCY) {
      // Called once at boot per container, so this warns ONCE: a sheet with
      // no quoted base is inert (serves null for every base — even one later
      // chosen in Studio), because we cannot know which base its rates were
      // written for. Warned rather than thrown: the deploy still boots and
      // the per-currency truth serves unchanged.
      deps.logger?.warn(
        "FX_RATES is set but BASE_CURRENCY is not — the static rate sheet has no quoted base and is INERT (no conversions will be served, even if a base currency is chosen in Studio). Set BASE_CURRENCY to the currency FX_RATES is quoted against.",
      );
    }
    return createStaticFxProvider({
      rates: parseFxRatesEnv(env.FX_RATES),
      asOf: env.FX_RATES_AS_OF ?? null,
      quotedBase: env.BASE_CURRENCY ?? null,
    });
  }
  return undefined;
}

/**
 * A resolved quote→base sheet, normalized for consumers: keys uppercased,
 * non-usable rates dropped, and the identity rate (base→base = 1) injected so
 * no reader special-cases the base currency. Carries the base it converts TO
 * — a sheet is only meaningful relative to its base, so readers never have to
 * pair it back up with the lens.
 */
export interface FxRatesToBase {
  baseCurrency: string;
  rates: Record<string, number>;
  asOf: string | null;
}

/**
 * The minimal FX surface the container exposes (`client.fx`). The effective
 * base currency is resolved PER CALL (never boot-frozen): the container's
 * resolver walks code pin → Studio operator setting → env `BASE_CURRENCY`,
 * so a base chosen/changed/cleared in Studio takes effect on the next
 * request without a reboot. Null base = the lens is OFF: `getRatesToBase`
 * resolves null and every consumer renders the unconverted truth, unchanged.
 */
export interface FxLens {
  /** The active rate source's id (`meta.id`), or null when none is wired. */
  providerId: string | null;
  /**
   * Resolve the operator's EFFECTIVE reporting currency (uppercased), or
   * null when the lens is off. Fail-soft: a throwing resolver reads as off.
   */
  getBaseCurrency(): Promise<string | null>;
  /**
   * Resolve the quote→base sheet from the active provider. Null when the
   * lens is off, no provider is configured, or the provider has nothing to
   * serve. NEVER throws — the lens is the fail-soft chokepoint even for a
   * misbehaving BYO provider, so no request path needs its own guard.
   */
  getRatesToBase(): Promise<FxRatesToBase | null>;
}

/** Build the container's {@link FxLens} from the base resolver + provider. */
export function createFxLens(opts: {
  /**
   * Resolves the effective base per call (the container builds it from the
   * code pin / operator setting / env precedence). Null = lens off.
   */
  resolveBaseCurrency: () => Promise<string | null>;
  provider?: FxRateProvider;
  logger: Logger;
}): FxLens {
  const provider = opts.provider;
  const resolveBase = async (): Promise<string | null> => {
    try {
      const base = await opts.resolveBaseCurrency();
      return base ? base.toUpperCase() : null;
    } catch (error) {
      // Same fail-soft posture as a misbehaving provider below: a resolver
      // that throws (e.g. a DB blip reading the operator setting) degrades
      // to lens-off for this request, never into a thrown request path.
      opts.logger.warn(
        "FX base-currency resolution threw — the base-currency lens is off for this request",
        { error: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
  };
  return {
    providerId: provider?.meta.id ?? null,
    getBaseCurrency: resolveBase,
    async getRatesToBase() {
      const baseCurrency = await resolveBase();
      if (!baseCurrency || !provider) return null;
      try {
        const sheet = await provider.getRates(baseCurrency);
        if (!sheet) return null;
        const rates: Record<string, number> = {};
        for (const [code, rate] of Object.entries(sheet.rates)) {
          if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
            rates[code.toUpperCase()] = rate;
          }
        }
        rates[baseCurrency] = 1;
        return { baseCurrency, rates, asOf: sheet.asOf ?? null };
      } catch (error) {
        // The provider contract says "never throw", but the lens holds the
        // line for providers that do anyway: converted figures degrade to
        // absent; the per-currency truth is always still served.
        opts.logger.warn(
          `FX provider "${provider.meta.id}" threw resolving rates — the base-currency lens is off for this request`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        return null;
      }
    },
  };
}
