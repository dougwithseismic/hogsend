/**
 * Parse the ONE origin allowlist governing `returnTo` (PRD 07) and the
 * `postMessage` targetOrigin (PRD 10). THROWS on a malformed entry rather than
 * dropping it: an allowlist is a security control, and a silently shortened one
 * produces a link button that spins to a timeout while the link has already
 * committed server-side — the single most likely first-run misconfiguration
 * (PRD 13). Precedent: FX_RATES is parsed outside the env schema for exactly
 * this reason (env.ts, lib/fx.ts).
 *
 * Accepts the csv env var (`ACCOUNT_LINK_ALLOWED_ORIGINS`) as a string, or the
 * consumer option (`accountLinks.allowedOrigins`) as an array — the container
 * concatenates env-first and parses both as ONE list, so the same rule applies
 * to each. Entries are trimmed, empties dropped, and each remaining entry must
 * be a parseable ABSOLUTE origin that round-trips (`new URL(e).origin === e`):
 * a path suffix, a bare `*`, or a wildcard host all throw naming the entry.
 * Returns the deduped list, order preserved.
 *
 * `source` names where the offending entry came from in the throw message;
 * the container's single merged call keeps the default naming both.
 */
export function parseAllowedOrigins(
  entries: string | string[] | undefined,
  source = "ACCOUNT_LINK_ALLOWED_ORIGINS / accountLinks.allowedOrigins",
): string[] {
  if (entries === undefined) return [];
  const raw = typeof entries === "string" ? entries.split(",") : entries;
  const origins: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    let origin: string | undefined;
    // Explicit, BEFORE the URL parse: `*` is not a forbidden host code point
    // in the WHATWG URL Standard, so `new URL("https://*.example.com")`
    // parses and its origin round-trips — the round-trip check alone would
    // wave a wildcard host (or a bare "*", on some runtimes) straight into a
    // postMessage targetOrigin. An allowlist entry is one literal origin.
    if (trimmed.includes("*")) {
      throw new Error(
        `allowed origin "${trimmed}" (from ${source}) is not an absolute ` +
          "origin — wildcards are never allowed. Each entry must be one " +
          'literal origin, e.g. "https://play.example.com"',
      );
    }
    try {
      origin = new URL(trimmed).origin;
    } catch {
      // fall through to the throw below with origin undefined
    }
    if (origin !== trimmed) {
      throw new Error(
        `allowed origin "${trimmed}" (from ${source}) is not an absolute ` +
          "origin. Each entry must be scheme + host [+ port] exactly — e.g. " +
          '"https://play.example.com" — with no path, no trailing slash, and ' +
          'never a wildcard or "*". A malformed allowlist entry is a security ' +
          "control failure, so it stops boot rather than being dropped",
      );
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}
