/**
 * http(s)-only guard, mirroring the engine's open-redirect check in mintLink
 * (`assertHttpUrl`). Client-side pre-validation only — the engine re-checks.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
