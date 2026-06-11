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
