import { Temporal } from "@js-temporal/polyfill";
import type { TimezoneCode } from "iana-db-timezones";

/**
 * A valid IANA timezone identifier (e.g. `"America/New_York"`, `"Europe/London"`)
 * — the full canonical + alias set, as a string-literal union. Sourced from
 * `iana-db-timezones` (type-only import, erased at build). Use this for
 * author-supplied timezones (`ctx.when.tz(...)`, client `defaults.timezone`) to
 * get autocomplete and compile-time typo-catching. Timezones that arrive as
 * runtime *data* (PostHog props, contact rows) stay plain `string` and are
 * validated via {@link isValidTimeZone}.
 */
export type TimeZone = TimezoneCode;

/**
 * True if `tz` is a usable IANA timezone identifier. Probes the zone via
 * Temporal inside a try/catch — it never throws, even on garbage input, so it
 * is safe to use as a validity gate in a precedence chain.
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz.length === 0) {
    return false;
  }
  try {
    // `Temporal.Now.zonedDateTimeISO(tz)` throws RangeError on an unknown zone.
    Temporal.Now.zonedDateTimeISO(tz);
    return true;
  } catch {
    return false;
  }
}
