import { type NextRequest, NextResponse } from "next/server";
import { CLOUD_SESSION_COOKIE_NAME } from "@/src/lib/auth-cookie";
import { guardRoute } from "@/src/lib/auth-guard";

/**
 * Route guard, on Next 16's `proxy` convention (the renamed `middleware`; the
 * old filename still works but logs a deprecation).
 *
 * All of the RULE lives in `guardRoute` (a pure function, unit tested); this
 * file only reads the cookie and turns the decision into a response.
 *
 * Both cookie names are checked because Better Auth prefixes the cookie with
 * `__Secure-` when the base URL is https — a production deploy would otherwise
 * look permanently signed out.
 */
export default function proxy(request: NextRequest): NextResponse {
  const hasSession =
    request.cookies.has(CLOUD_SESSION_COOKIE_NAME) ||
    request.cookies.has(`__Secure-${CLOUD_SESSION_COOKIE_NAME}`);

  const decision = guardRoute({
    pathname: request.nextUrl.pathname,
    hasSession,
  });

  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = decision.to;
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Never intercept the auth handler itself (it would redirect sign-in away),
  // Next internals, or static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|images).*)"],
};
