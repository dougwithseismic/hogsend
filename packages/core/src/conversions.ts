import { normalizeWhere } from "./conditions/index.js";
import type { PropertyCondition } from "./types/conditions.js";
import type { JourneyWhere } from "./types/journey.js";

/**
 * Conversion-point definitions (docs/revenue-attribution-plan.md §5.1) — the
 * product's atomic unit: WHICH event, under WHAT conditions, counts as a
 * valued conversion for a campaign/journey/deployment, and where the value
 * comes from. Code-first like journeys/campaigns; fired instances are
 * recorded in the `conversions` table by the engine's ingest hook and fanned
 * out to conversion destinations (§5.2).
 */

export type ConversionValueSource =
  /** The event's own first-class `value`/`currency` (the revenue spine). */
  | { source: "event" }
  /** A constant per conversion (e.g. a known LTV proxy). */
  | { source: "fixed"; amount: number; currency?: string }
  /** Read from event properties (numeric), with an optional currency key. */
  | { source: "property"; key: string; currencyKey?: string };

export interface ConversionMeta {
  /** Stable id — recorded on every fired conversion row. */
  id: string;
  name?: string;
  description?: string;
  /**
   * Optional scoping for reporting (a journey's conversion, a campaign's
   * conversion). Purely descriptive — the trigger decides what fires.
   */
  scope?: { journeyId?: string; campaignId?: string };
  /** The event that fires this conversion point. */
  trigger: {
    event: string;
    /**
     * Property conditions — array or the same builder journeys use. The
     * event's first-class `value`/`currency` are visible as `value`/
     * `currency` (they win a property-name collision), so value gates like
     * `(b) => b.prop("value").gte(10000)` work on money events.
     */
    where?: JourneyWhere;
  };
  /**
   * Ingest-source allowlist (the forged-value guard, plan §5.1). Browser
   * (`inapp`) events are pk_-trust-tier: anyone can mint them with any value.
   * DEFAULT: every source EXCEPT `inapp`. Pass explicit source ids to narrow
   * further (e.g. `["crm"]`), or `"any"` to accept browser events too.
   */
  sources?: string[] | "any";
  /** Where the conversion's value comes from. Default: the event's value. */
  value?: ConversionValueSource;
  /**
   * Attribution lookback window (days) the credit engine (§6) applies over
   * the contact's touchpoints. Default 90.
   */
  attributionWindowDays?: number;
  /** Conversion-destination ids (§5.2) this conversion dispatches to. */
  destinations?: string[];
}

export interface DefinedConversion {
  meta: ConversionMeta;
  /** The trigger's `where`, normalized to conditions at definition time. */
  where: PropertyCondition[] | undefined;
}

/**
 * Identity/validating factory — normalizes the builder-style `where` once at
 * definition time (mirrors `defineJourney`'s trigger handling).
 */
export function defineConversion(meta: ConversionMeta): DefinedConversion {
  return { meta, where: normalizeWhere(meta.trigger.where) };
}

/**
 * The source gate: `inapp` (browser, pk_) is denied unless explicitly
 * allowed; a configured allowlist takes precedence. `source` is null for
 * pre-provenance events — treated as server-side (only the engine writes
 * null-source events).
 */
export function conversionSourceAllowed(
  def: DefinedConversion,
  source: string | null | undefined,
): boolean {
  const sources = def.meta.sources;
  if (sources === "any") return true;
  if (Array.isArray(sources)) {
    return source != null && sources.includes(source);
  }
  return source !== "inapp";
}

/**
 * Resolve the conversion's value from the fired event. Returns nulls when
 * the configured source yields nothing (a conversion may legitimately be
 * value-less — e.g. a schedule-booked signal).
 */
export function resolveConversionValue(
  def: DefinedConversion,
  event: {
    value?: number | null;
    currency?: string | null;
    properties: Record<string, unknown>;
  },
): { value: number | null; currency: string | null } {
  const valueSource = def.meta.value ?? { source: "event" as const };
  if (valueSource.source === "fixed") {
    return {
      value: valueSource.amount,
      currency: valueSource.currency?.toUpperCase() ?? null,
    };
  }
  if (valueSource.source === "property") {
    const raw = event.properties[valueSource.key];
    const amount = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(amount)) return { value: null, currency: null };
    const currencyRaw = valueSource.currencyKey
      ? event.properties[valueSource.currencyKey]
      : undefined;
    return {
      value: amount,
      currency:
        typeof currencyRaw === "string" && /^[A-Za-z]{3}$/.test(currencyRaw)
          ? currencyRaw.toUpperCase()
          : null,
    };
  }
  return {
    value: event.value ?? null,
    currency: event.currency ?? null,
  };
}
