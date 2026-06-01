import { isValidTimeZone } from "@hogsend/core/schedule";

export interface ResolveTimezoneInput {
  /** Explicit per-call override, e.g. from `ctx.when.tz("Area/City")`. */
  explicit?: string;
  /** PostHog person properties ($timezone, $geoip_time_zone). */
  posthogProperties?: Record<string, unknown>;
  /** The `contacts.timezone` cache column. */
  contactTimezone?: string | null;
  /** The `contacts.properties` jsonb. */
  contactProperties?: Record<string, unknown> | null;
  /** The client `defaults.timezone`. */
  defaultTimezone?: string;
  logger?: { warn(msg: string): void };
}

/**
 * Source of a resolved timezone, surfaced so callers (e.g. `define-journey`)
 * can decide whether to opportunistically cache it back to `contacts.timezone`.
 */
export type TimezoneSource =
  | "explicit"
  | "posthog_timezone"
  | "posthog_geoip"
  | "contact_column"
  | "contact_properties"
  | "default"
  | "fallback";

export interface ResolveTimezoneResult {
  timezone: string;
  source: TimezoneSource;
}

function candidate(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve a user's IANA timezone via the precedence chain. The first *valid*
 * candidate wins; invalid candidates are skipped and warned. Never throws —
 * the terminal fallback is `"UTC"`.
 *
 * Precedence: explicit → PostHog `$timezone` → PostHog `$geoip_time_zone` →
 * `contacts.timezone` → `contacts.properties.timezone` → client default → UTC.
 */
export function resolveTimezoneWithSource(
  input: ResolveTimezoneInput,
): ResolveTimezoneResult {
  const { logger } = input;

  const chain: Array<{ value: string | undefined; source: TimezoneSource }> = [
    { value: candidate(input.explicit), source: "explicit" },
    {
      value: candidate(input.posthogProperties?.$timezone),
      source: "posthog_timezone",
    },
    {
      value: candidate(input.posthogProperties?.$geoip_time_zone),
      source: "posthog_geoip",
    },
    { value: candidate(input.contactTimezone), source: "contact_column" },
    {
      value: candidate(input.contactProperties?.timezone),
      source: "contact_properties",
    },
    { value: candidate(input.defaultTimezone), source: "default" },
  ];

  for (const { value, source } of chain) {
    if (value === undefined) continue;
    if (isValidTimeZone(value)) {
      return { timezone: value, source };
    }
    logger?.warn(`resolveTimezone: ignoring invalid tz '${value}'`);
  }

  return { timezone: "UTC", source: "fallback" };
}

/** Convenience wrapper returning just the resolved IANA timezone string. */
export function resolveTimezone(input: ResolveTimezoneInput): string {
  return resolveTimezoneWithSource(input).timezone;
}
