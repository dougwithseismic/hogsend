/**
 * Validate a post-auth redirect target. Accepts ONLY a same-origin relative path
 * (a single leading `/`, not `/api/`); rejects absolute URLs, protocol-relative
 * `//evil.com`, backslash tricks, and any control/whitespace characters. This
 * reduces the open-redirect surface on the sign-in `?next=` param — it is a
 * defense-in-depth layer, NOT the sole guard: Better Auth independently
 * re-validates any callbackURL against trustedOrigins. Pure (no server-only
 * deps) so it's cheap to import on client + server.
 */
export function safeNext(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0) return null;
  if (!next.startsWith("/")) return null; // must be relative
  if (next.startsWith("//")) return null; // protocol-relative
  if (next.includes("\\")) return null; // backslash trick
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return null; // control chars + space
  }
  if (next.startsWith("/api/")) return null; // not a page
  return next;
}
