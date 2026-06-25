/**
 * URL-segment → display name. Letters (any script) plus spaces/apostrophes,
 * 1–24 chars, max two words, title-cased — anything else (digits, symbols,
 * over-long strings) falls back to the generic page. -_+. are treated as
 * word separators so /hey/mary-jane works — which also means all-letter
 * slugs like /hey/free-money render as a (weird) name; output is escaped,
 * capped and title-cased, so the worst case is an odd greeting, not an
 * injection vector.
 */
const NAME_PATTERN = /^[\p{L}][\p{L}' ]{0,23}$/u;

export function displayNameFromSlug(raw: string | undefined): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const cleaned = decoded
    .replace(/[-_+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!NAME_PATTERN.test(cleaned)) return null;
  return cleaned
    .split(" ")
    .slice(0, 2)
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Upper bound on the referral ref token (matches the server route). */
const MAX_REF_LENGTH = 200;

/**
 * Sanitise the `?ref` token — the referrer's opaque Hogsend contact key from
 * the referral-ask email's `/hey/<name>?ref=<key>` link. Unlike the display
 * name this is NOT decoded into prose or shown anywhere: it's an opaque
 * attribution token, so we only trim it, bound its length, and drop empty or
 * array-valued params (Next gives `string | string[] | undefined`). It is sent
 * verbatim to the server and never rendered, so no further escaping is needed.
 */
export function sanitizeRefParam(
  raw: string | string[] | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_REF_LENGTH) return null;
  return trimmed;
}
