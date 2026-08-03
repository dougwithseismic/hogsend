import { LEGAL_PATHS } from "./legal";

/**
 * Routes anybody may read, signed in or out. Listed explicitly rather than
 * relying on the default-open fallback below: the legal pages are linked from
 * the auth screens, so "a signed-out visitor can open them" is a rule this app
 * owes, not an accident of ordering that a later prefix could break.
 */
export const PUBLIC_ROUTES = [...LEGAL_PATHS] as const;

/** Dashboard routes: a session is required, and their prefixes' subroutes. */
export const PROTECTED_PREFIXES = [
  "/",
  "/environments",
  "/usage",
  "/settings",
  // The post-signup key step. A dashboard route like any other: it reads and
  // writes the organization's provider credentials, so a signed-out visitor
  // has no business rendering it.
  "/setup",
  // The CLI device-flow approve page. Signed-in-only is the ENTIRE security
  // model of the device flow: a user code names a pending login, and only a
  // real dashboard session can turn it into an approved one.
  "/cli",
  // Signed-in-only too, but it is where the org-less land rather than a
  // dashboard page — the redirect INTO it is `session.ts`'s job, because only a
  // database read knows whether the user has an organization.
  "/create-org",
] as const;

/** Auth screens: a signed-in visitor has no business here. */
export const AUTH_ROUTES = ["/login", "/signup"] as const;

/**
 * Routes rendered without the dashboard chrome. The auth screens, the legal
 * pages, create-org, and the invitation page: a nav rail whose every link
 * redirects straight back here is furniture the visitor cannot use yet. The
 * invited visitor may have no organization at all until they press Accept, and
 * a reader of the legal pages may have no account at all.
 */
export const BARE_ROUTES = [
  ...AUTH_ROUTES,
  ...PUBLIC_ROUTES,
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

/**
 * The sign-in URL that comes BACK to `next` afterwards.
 *
 * It exists for the CLI approve page: a device-flow link mailed, pasted or
 * opened by `hogsend login` arrives at `/cli/approve?code=…`, and a visitor
 * whose session had lapsed must land on that exact page — code and all — after
 * signing in, or the flow dead-ends on a dashboard with no way back.
 *
 * `sanitizeNext` runs on the way IN as well as on the way out, so a caller
 * cannot smuggle an absolute URL into the round-trip. `/` is left bare: there
 * is nothing to return to.
 */
export function loginHref(next?: string | null): string {
  const target = sanitizeNext(next, "/");
  return target === "/"
    ? "/login"
    : `/login?next=${encodeURIComponent(target)}`;
}

/** The same rule, for the middleware, which has a pathname and a query. */
export function loginRedirectTarget(input: {
  pathname: string;
  search?: string;
}): { pathname: string; search: string } {
  const href = loginHref(`${input.pathname}${input.search ?? ""}`);
  const [pathname = "/login", search] = href.split("?");
  return { pathname, search: search ? `?${search}` : "" };
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

  // Checked first: a public page answers the same to everyone, and a session
  // is not a reason to be redirected away from the terms you are reading.
  if (PUBLIC_ROUTES.some((route) => matches(pathname, route))) {
    return { action: "allow" };
  }

  // Auth screens are ALWAYS reachable at this layer. `hasSession` here is
  // optimistic (the proxy only sees that a cookie EXISTS, not that its session
  // row is alive) — bouncing /login → / on a dead cookie ping-pongs with the
  // page-level "no real session → /login" redirect and reloads forever. The
  // "already signed in, leave /login" bounce lives in the login/signup PAGES,
  // which hold the real session verdict.
  if (AUTH_ROUTES.some((route) => matches(pathname, route))) {
    return { action: "allow" };
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
