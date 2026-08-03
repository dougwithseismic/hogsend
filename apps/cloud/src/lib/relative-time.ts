/**
 * Timestamps as a human reads them, with the exact instant never thrown away.
 *
 * Two rules the dashboard follows everywhere:
 *  - the visible text is coarse ("4 minutes ago") because that is the question
 *    an operator is actually asking of a health sweep or a provisioning step;
 *  - the ISO instant rides along in a `title`, so the precise answer is one
 *    hover away and a support conversation can quote a timestamp.
 *
 * Rendered on the SERVER, from a clock passed in. A component that formatted
 * "ago" in the browser would disagree with the server's render on the first
 * paint, and React would flag the hydration mismatch.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coarse, past-tense, no decimals. "just now" under a minute. */
export function formatRelativeTime(at: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - at.getTime();
  // A clock skew (or a `checked_at` written a beat ahead) must not print a
  // negative age; the honest reading of "not yet a minute old" is the same.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), "hour");
  return plural(Math.floor(elapsed / DAY), "day");
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** The exact instant, for the `title` attribute. */
export function exactTime(at: Date): string {
  return at.toISOString();
}
