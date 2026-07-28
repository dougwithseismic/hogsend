/** Dashboard routes: a session is required, and their prefixes' subroutes. */
export const PROTECTED_PREFIXES = [
  "/",
  "/environments",
  "/usage",
  "/settings",
  // Signed-in-only too, but it is where the org-less land rather than a
  // dashboard page — the redirect INTO it is `session.ts`'s job, because only a
  // database read knows whether the user has an organization.
  "/create-org",
] as const;

/** Auth screens: a signed-in visitor has no business here. */
export const AUTH_ROUTES = ["/login", "/signup"] as const;

/**
 * Routes rendered without the dashboard chrome. The auth screens, create-org,
 * and the invitation page: a nav rail whose every link redirects straight back
 * here is furniture the visitor cannot use yet. The invited visitor may have no
 * organization at all until they press Accept.
 */
export const BARE_ROUTES = [
  ...AUTH_ROUTES,
  "/create-org",
  "/accept-invitation",
] as const;

/**
 * Sanitize a `?next=` destination.
 *
 * Only a path on this origin is ever returned: an absolute URL (or the
 * protocol-relative `//evil.example`) in a redirect the app performs after
 * sign-in is an open redirect, and the invitation link is exactly the kind of
 * mail-delivered URL that gets tampered with.
 */
export function sanitizeNext(
  value: string | null | undefined,
  fallback = "/",
): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}

export type GuardDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string };

function matches(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The whole routing rule, as one pure function — no `Request`, no cookies API —
 * so it is unit-testable without a server and the middleware stays a two-line
 * adapter around it.
 *
 * `hasSession` is deliberately "is a session cookie PRESENT", not "is it
 * valid": middleware runs on the edge with no database, so this is a cheap
 * gate, and the pages themselves still resolve the real session. A forged
 * cookie buys a redirect, never data.
 */
export function guardRoute(input: {
  pathname: string;
  hasSession: boolean;
}): GuardDecision {
  const { pathname, hasSession } = input;

  if (AUTH_ROUTES.some((route) => matches(pathname, route))) {
    return hasSession ? { action: "redirect", to: "/" } : { action: "allow" };
  }

  if (PROTECTED_PREFIXES.some((prefix) => matches(pathname, prefix))) {
    return hasSession
      ? { action: "allow" }
      : { action: "redirect", to: "/login" };
  }

  // Everything else (API routes, legal pages, assets) is not this guard's
  // business — an unlisted path defaults to open rather than to a redirect
  // loop.
  return { action: "allow" };
}
