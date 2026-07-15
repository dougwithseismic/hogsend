// ---------------------------------------------------------------------------
// FX rate sheet (the one thing a provider returns)
// ---------------------------------------------------------------------------

/**
 * One resolved batch of quote→base conversion rates. `rates` maps an ISO-4217
 * quote code to "how many BASE units one QUOTE unit is worth" — e.g. with
 * base `USD`, `{ JPY: 0.0065 }` means 1 JPY is 0.0065 USD. `asOf` is the ISO
 * date the rates were published for (an ECB reference date, an operator's
 * chosen valuation date), or null when the source carries no date — the
 * engine surfaces it verbatim so the Studio can label converted figures
 * honestly ("≈ in USD, rates as of 2026-07-01").
 */
export interface FxRateSheet {
  rates: Record<string, number>;
  asOf: string | null;
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * Provider identity. Unlike email/SMS there is NO registry keyed by this id —
 * exactly one FX provider is resolved at boot (multiple simultaneous rate
 * sources have no use case) — but the id still names the source in logs and
 * keeps the contract uniform with its email/SMS/analytics siblings.
 */
export interface FxRateProviderMeta {
  id: string;
  name: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// FxRateProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The currency-conversion rate source behind the OPTIONAL base-currency lens
 * (docs/groups.md §Base-currency lens). The engine's revenue LAW is that
 * currencies are never summed together (`lib/revenue.ts`); this contract
 * exists so an operator can OPT INTO a converted view — a base-currency
 * approximation layered on top of the per-currency truth — without the money
 * path ever hard-wiring an external rates API.
 *
 * A provider owns exactly ONE wire: `getRates(base)`. It is a dumb rate
 * source — what a conversion means (which totals convert, when a partial sum
 * must be refused, how a ranking falls back) lives in the engine, never here.
 *
 * FAIL-SOFT is part of the contract: a provider that cannot serve rates
 * (network down, cold cache, unsupported base) resolves `null` — it must not
 * throw into a request path. Converted figures degrade to absent; the
 * per-currency truth is always still there.
 */
export interface FxRateProvider {
  /** Provider identity. Names the rate source in logs and boot output. */
  readonly meta: FxRateProviderMeta;

  /**
   * Resolve the quote→base rate sheet for `base` (a 3-letter ISO-4217 code,
   * uppercased by the engine). Each rate answers "how many `base` is 1 unit
   * of the quote currency". Resolves `null` when rates are unavailable —
   * NEVER throws. The sheet need not include `base` itself; the engine
   * injects the identity rate (base→base = 1).
   */
  getRates(base: string): Promise<FxRateSheet | null>;
}

/**
 * Identity factory for an {@link FxRateProvider}. Mirrors `defineSmsProvider` —
 * returns its argument unchanged but pins the literal shape to the contract,
 * so a typo in `meta` or a missing `getRates` is caught at definition time.
 */
export function defineFxRateProvider(provider: FxRateProvider): FxRateProvider {
  return provider;
}
