import { steamReturnTo } from "@hogsend/core";
import type { Context } from "hono";
import type { AppEnv } from "../../app.js";

/**
 * Pieces both hosted account-link routes need. Kept here rather than duplicated
 * so `/start` and `/callback` cannot drift on the two things that MUST agree
 * byte-for-byte: the callback URL they present, and the anon-id cookie.
 */

/**
 * The redirect URI this deployment presents for a provider, byte-exact.
 *
 * `/start` hands it to `authorizeUrl` and `/callback` hands it to
 * `handleCallback`, where OAuth2 providers compare it verbatim against the
 * authorize leg and Steam compares its `openid.return_to` echo against it. The
 * trailing slash on `API_PUBLIC_URL` is the one operator-controlled degree of
 * freedom, so it is stripped in exactly one place (the same normalization
 * `lib/account-links-from-env.ts` applies to the Steam realm).
 */
export function accountLinkCallbackUrl(
  apiPublicUrl: string,
  providerId: string,
): string {
  return `${apiPublicUrl.replace(/\/+$/, "")}/v1/accounts/${encodeURIComponent(providerId)}/callback`;
}

/**
 * The redirect URI to present on the CALLBACK leg, which is not always the one
 * the authorize leg presented.
 *
 * OAuth2 carries the state in its own `state` parameter, so its `redirect_uri`
 * is the bare callback URL on BOTH legs and the token exchange compares it
 * verbatim. OpenID 2.0 has no state parameter at all, so `steamOpenIdLink`
 * folds our signed state into `openid.return_to` and its callback guard
 * compares the echoed value BYTE-FOR-BYTE against the `redirectUri` we pass —
 * which therefore has to carry the state.
 *
 * The discriminator is the presence of an `openid.*` parameter, because PRD 01
 * froze the provider contract with no protocol flag and a hardcoded
 * `providerId === "steam"` would break the moment a consumer registers their
 * own OpenID 2.0 provider under another id.
 *
 * It is SAFE for the discriminator to be attacker-influenced. The state folded
 * in is the one this route ALREADY signature-verified and nonce-burned, never
 * the attacker's echoed `openid.return_to` — so the comparison stays a real
 * channel binding, and the worst a stray `openid.*` param on an OAuth2 callback
 * achieves is a `redirect_uri` that provider's own exchange then rejects.
 */
export function accountLinkCallbackRedirectUri(args: {
  apiPublicUrl: string;
  providerId: string;
  /** The VERIFIED state token, exactly as it was minted. */
  state: string;
  query: Record<string, string>;
}): string {
  const base = accountLinkCallbackUrl(args.apiPublicUrl, args.providerId);
  const isOpenId = Object.keys(args.query).some((key) =>
    key.startsWith("openid."),
  );
  if (!isOpenId) return base;
  // `steamReturnTo` is the preset's OWN builder, exported so this route
  // constructs the same string it presented rather than a lookalike. Calling it
  // is what makes "byte-for-byte" true instead of aspirational.
  return steamReturnTo(base, args.state);
}

/**
 * Best-effort client IP for the throttle buckets — the same header order the
 * rate-limit middleware and the tracking routes use. `"unknown"` shares ONE
 * bounded bucket rather than bypassing the budget.
 */
export function accountLinkClientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/**
 * The cookie `/start` sets when it MINTS a cold anonymous key, so the browser
 * carries the same key afterwards. Same name the browser SDK persists under
 * (`packages/js/src/identity/identity-store.ts`), so a page that wants to adopt
 * the key into the SDK reads one name.
 *
 * Deliberately NOT `HttpOnly`: an anonymous id is browser-readable BY DESIGN
 * (`get_distinct_id()` returns it), which is exactly why a cold link may attach
 * only to an anonymous-only contact (DECISIONS §6.10). Marking it HttpOnly
 * would imply a secrecy the value does not have, and would stop the SDK
 * adopting it, which is the whole point of setting it.
 */
export const ANON_ID_COOKIE = "hs_anon_id";

/** One year, matching the SDK's own persistence horizon for the anon key. */
const ANON_ID_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function anonIdCookie(value: string, apiPublicUrl: string): string {
  const secure = apiPublicUrl.startsWith("https://") ? "; Secure" : "";
  // `SameSite=Lax` survives the top-level GET redirect back from the provider,
  // which `Strict` would drop — the cookie would then be set and immediately
  // invisible on the leg that needs it.
  return (
    `${ANON_ID_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=` +
    `${ANON_ID_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
  );
}
