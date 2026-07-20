import type { TouchpointChannel } from "./attribution/touchpoints.js";
import { normalizeWhere } from "./conditions/index.js";
import type { DurationObject } from "./duration.js";
import type { PropertyCondition } from "./types/conditions.js";
import type { JourneyWhere } from "./types/journey.js";

/**
 * Conversion-point definitions — the
 * product's atomic unit: WHICH event, under WHAT conditions, counts as a
 * valued conversion for a campaign/journey/deployment, and where the value
 * comes from. Code-first like journeys/campaigns; fired instances are
 * recorded in the `conversions` table by the engine's ingest hook and fanned
 * out to conversion destinations (§5.2).
 *
 * MILESTONES are a convention, not a
 * type: a conversion definition whose meaning is progress rather than money
 * — `activation.completed`, `trial.started`, a canonical stage event. Define
 * one exactly like a revenue conversion but on a valueless event (or omit
 * `value`); it fires, earns weight-only attribution credits (value NULL),
 * and answers "which journeys drive activation" without a currency in
 * sight. No `kind` field until Studio grouping needs one.
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
  /**
   * Per-channel lookback overrides.
   * A channel listed here uses its own window instead of
   * `attributionWindowDays`; unlisted channels keep the definition-wide
   * window, so existing single-window definitions are untouched. Industry
   * convention for comparability with incumbent tools: email `days(5)`,
   * sms `days(1)` (Klaviyo-style click windows) — documented defaults to
   * reach for, never imposed. Changes apply FORWARD only (the ledger is
   * written at conversion time); the backfill command is the recompute path.
   */
  windows?: Partial<Record<TouchpointChannel, DurationObject>>;
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
 * The shared ingest-source gate: `inapp` (browser, pk_) is denied unless
 * explicitly allowed; a configured allowlist takes precedence. `source` is
 * null for pre-provenance events — treated as server-side (only the engine
 * writes null-source events). Used by conversions AND funnel event triggers
 * (one gate concept, one implementation).
 */
export function sourceAllowed(
  sources: string[] | "any" | undefined,
  source: string | null | undefined,
): boolean {
  if (sources === "any") return true;
  if (Array.isArray(sources)) {
    return source != null && sources.includes(source);
  }
  return source !== "inapp";
}

/** {@link sourceAllowed} over a conversion definition's allowlist. */
export function conversionSourceAllowed(
  def: DefinedConversion,
  source: string | null | undefined,
): boolean {
  return sourceAllowed(def.meta.sources, source);
}

/**
 * The `where` money overlay: conditions see the event's first-class
 * `value`/`currency` as properties (money events carry no property twin),
 * so "quotes over £10k" is expressible — the columns win a name collision.
 * Shared by conversion `where` and funnel-trigger `where`.
 */
export function overlayEventMoney(
  properties: Record<string, unknown>,
  value: number | null,
  currency: string | null,
): Record<string, unknown> {
  return value !== null
    ? { ...properties, value, ...(currency ? { currency } : {}) }
    : properties;
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
