import {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "@/src/lib/user-code-shape";

/**
 * The input-side half of the user-code rules: what the segmented code boxes on
 * `/cli/approve` accept from typing, pasting, and the `?code=` prefill.
 *
 * The SERVER's `normalizeUserCode` is the judge — it refuses anything outside
 * the alphabet so a typo stays a typo. This is the keyboard-side complement:
 * characters the alphabet excludes (`I`, `L`, `O`, `U`, `0`, `1`) simply never
 * land in a box, so the human sees the keystroke not take instead of
 * submitting a code the server will refuse. Dashes and whitespace are display
 * punctuation, not code, so a pasted `KS66-XZSM` fills all eight boxes.
 */

// Re-exported so the input component reads shape and sanitizer from one place.
export { USER_CODE_LENGTH };

/**
 * Uppercase, drop display punctuation (whitespace and dashes), keep only
 * alphabet characters, cap at the code length. Suitable for a single
 * keystroke, a full paste, or the `?code=` query parameter alike.
 */
export function sanitizeUserCodeInput(raw: string): string {
  let out = "";
  for (const char of raw.toUpperCase()) {
    if (out.length === USER_CODE_LENGTH) break;
    if (/[\s-]/.test(char)) continue;
    if (USER_CODE_ALPHABET.includes(char)) out += char;
  }
  return out;
}
