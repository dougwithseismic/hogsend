/**
 * Same-site redirect guard for post-sign-in navigation. Returns the input ONLY
 * if it resolves to a same-origin RELATIVE path; anything that would leave the
 * site — protocol-relative (`//evil.com`), backslash tricks (`/\evil.com`, which
 * browsers normalise to `//`), an absolute URL, or a non-http scheme
 * (`javascript:`) — collapses to `/`. It resolves the value against a throwaway
 * base and confirms the origin did not move, so a crafted `next` can never
 * bounce a freshly-authenticated visitor to an attacker-controlled origin.
 *
 * Pure (no `window`), so it is safe in both the server page and the client form.
 */
export function safeInternalPath(next: string): string {
  const base = "https://x.invalid";
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return "/";
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path.startsWith("/") ? path : "/";
  } catch {
    return "/";
  }
}
