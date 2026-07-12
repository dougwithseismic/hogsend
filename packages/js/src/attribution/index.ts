/**
 * Ad-click / campaign attribution capture — the browser end of the revenue
 * spine (docs/revenue-attribution-plan.md §Phase 2).
 *
 * On an attributed landing (any allowlisted click ID or `utm_*` param in the
 * URL) the client fires ONE `campaign.arrived` event carrying the params as
 * flat scalar properties, and persists the set as the LAST-TOUCH attribution
 * in storage so a later form submit (possibly on a rented form tool) can carry
 * it via hidden fields — {@link buildAttributionFields}.
 *
 * The event's `occurredAt` (ingest time ≈ click time) is the click timestamp a
 * Meta CAPI dispatch later needs to reconstruct `fbc`
 * (`fb.1.<click_ts_ms>.<fbclid>`), which is why arrivals must be captured the
 * moment they happen, not reconstructed at conversion time.
 *
 * Everything URL-shaped is pure and testable; only the thin client wiring
 * touches browser globals.
 */

/**
 * Click-ID params captured verbatim, keyed by the exact query-param name.
 * Generic by design: adding a platform is config, not code.
 */
export const CLICK_ID_PARAMS = [
  "fbclid", // Meta
  "gclid", // Google
  "gbraid", // Google (iOS, app-to-web)
  "wbraid", // Google (iOS, web-to-app)
  "ttclid", // TikTok
  "msclkid", // Microsoft
  "li_fat_id", // LinkedIn
  "twclid", // X/Twitter
  "rdt_cid", // Reddit
  "epik", // Pinterest
  "sccid", // Snap
] as const;

export type ClickIdParam = (typeof CLICK_ID_PARAMS)[number];

/** A parsed attributed landing. `null` when the URL carries no attribution. */
export interface ParsedAttribution {
  /** Allowlisted click IDs present on the landing URL, verbatim. */
  clickIds: Partial<Record<ClickIdParam, string>>;
  /** Every `utm_*` param present, keyed by its full name (`utm_source`, …). */
  utm: Record<string, string>;
  /** Origin + pathname — the query string is deliberately dropped. */
  landingPage: string;
  referrer: string;
}

/** The persisted last-touch record ({@link ATTRIBUTION_STORAGE_KEY}). */
export interface StoredAttribution extends ParsedAttribution {
  capturedAt: string;
}

export const ATTRIBUTION_STORAGE_KEY = "hs_attribution";

/**
 * Parse an attributed landing out of a URL. Returns `null` when neither a
 * click ID nor a `utm_*` param is present (the common non-campaign pageload —
 * this module then does nothing at all).
 */
export function parseAttribution(
  href: string,
  referrer: string,
): ParsedAttribution | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const clickIds: Partial<Record<ClickIdParam, string>> = {};
  for (const param of CLICK_ID_PARAMS) {
    const value = url.searchParams.get(param);
    if (value) clickIds[param] = value;
  }

  const utm: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("utm_") && value) utm[key] = value;
  }

  if (Object.keys(clickIds).length === 0 && Object.keys(utm).length === 0) {
    return null;
  }

  return { clickIds, utm, landingPage: url.origin + url.pathname, referrer };
}

/**
 * Flatten a parsed attribution into the scalar event-properties bag for
 * `campaign.arrived` — journeys' `trigger.where`/`exitOn` and the Hatchet
 * payload only see scalars, so nesting would hide the values from them.
 */
export function toArrivalProperties(
  parsed: ParsedAttribution,
): Record<string, string> {
  return {
    ...parsed.clickIds,
    ...parsed.utm,
    landing_page: parsed.landingPage,
    ...(parsed.referrer ? { referrer: parsed.referrer } : {}),
  };
}

/**
 * Stable signature of an attributed landing — the dedup discriminant. One
 * `campaign.arrived` fires per (signature, anon id, UTC day): a same-session
 * reload never re-fires (session guard), a same-day re-click of the same ad
 * link dedups server-side, and a genuine re-click on a later day is a new
 * touchpoint.
 */
export function arrivalSignature(parsed: ParsedAttribution): string {
  const entries = [
    ...Object.entries(parsed.clickIds),
    ...Object.entries(parsed.utm),
    ["p", parsed.landingPage] as const,
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // djb2 over the canonical serialization — collision-tolerant (a collision
  // only merges two same-day arrival dedup keys).
  let hash = 5381;
  const canonical = entries.map(([k, v]) => `${k}=${v}`).join("&");
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Flatten the persisted last-touch set (plus the anon id) into hidden-field
 * values for a third-party form (Heyflow/Perspective/etc.), so the eventual
 * `lead.submitted` webhook carries the identity + click IDs back to the
 * engine. Returns `{}` when nothing was captured.
 */
export function buildAttributionFields(
  stored: StoredAttribution | null,
  anonymousId: string,
): Record<string, string> {
  if (!stored) return { hs_anonymous_id: anonymousId };
  return {
    hs_anonymous_id: anonymousId,
    ...stored.clickIds,
    ...stored.utm,
    hs_landing_page: stored.landingPage,
    hs_captured_at: stored.capturedAt,
  };
}
