/**
 * Strict E.164 normalization. Strips common human separators (spaces, dashes,
 * parens, dots) then requires a leading `+`, a non-zero country digit, and
 * 7–15 total digits (the E.164 max is 15). Fail-closed: anything that doesn't
 * match returns `null` — the caller rejects it rather than guessing a country
 * code (no libphonenumber dependency, no implicit `+1`).
 */
export function normalizePhone(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const stripped = input.trim().replace(/[\s\-().]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(stripped) ? stripped : null;
}

/** Whether `input` is already a valid E.164 number (post-normalization). */
export function isE164(input: string | null | undefined): boolean {
  return normalizePhone(input) !== null;
}
