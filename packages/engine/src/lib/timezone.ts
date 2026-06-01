import { isValidTimeZone, type TimeZone } from "@hogsend/core/schedule";
import { contacts, type Database } from "@hogsend/db";
import { eq } from "drizzle-orm";

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

  // An explicit (author-supplied) timezone is a hard contract: if it is present
  // but invalid, throw rather than silently falling through to UTC. Data-sourced
  // candidates below stay lenient (warn + skip) — they are not author input.
  const explicit = candidate(input.explicit);
  if (explicit !== undefined && !isValidTimeZone(explicit)) {
    throw new TypeError(
      `resolveTimezone: invalid explicit timezone "${explicit}"`,
    );
  }

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

/**
 * Persist a known timezone for a contact (e.g. one the user picked in your
 * app's settings) into the canonical `contacts.timezone` column, so the
 * resolution chain prefers it over PostHog/geoip on the next journey run.
 *
 * Validates the zone and throws `TypeError` on an invalid one — this is an
 * explicit, author-driven write, not best-effort data ingestion. Returns
 * `{ updated: false }` if no contact exists yet for `userId` (it is created on
 * first event ingestion); call again once the contact exists.
 */
export async function setContactTimezone(opts: {
  db: Database;
  userId: string;
  timezone: TimeZone;
}): Promise<{ updated: boolean }> {
  const { db, userId, timezone } = opts;

  if (!isValidTimeZone(timezone)) {
    throw new TypeError(`setContactTimezone: invalid timezone "${timezone}"`);
  }

  const rows = await db
    .update(contacts)
    .set({ timezone, updatedAt: new Date() })
    .where(eq(contacts.externalId, userId))
    .returning({ id: contacts.id });

  return { updated: rows.length > 0 };
}
