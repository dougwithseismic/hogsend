import type { Database } from "@hogsend/db";
import * as schema from "@hogsend/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import type { AuthSecondaryStorage } from "./redis.js";

/**
 * Delivers the password-reset link. Injected by `createHogsendClient` (wired to
 * the engine mailer) so the auth-construction layer stays decoupled from the
 * email pipeline, and so tests can pass a spy and assert the callback fires
 * without sending. Defaults to a no-op so a bare `createAuth({ db, secret,
 * baseURL })` (e.g. the CLI's headless instance) doesn't try to send mail.
 *
 * Receives better-auth's `{ user, url, token }`: `url` is the
 * `${baseURL}/api/auth/reset-password/:token?callbackURL=…` link that, when
 * clicked, redirects the browser to the Studio reset route with `?token=`. NEVER
 * log `url`/`token`.
 */
export type SendResetPasswordFn = (args: {
  user: { email: string; id: string };
  url: string;
  token: string;
}) => Promise<void>;

export function createAuth(opts: {
  db: Database;
  secret: string;
  baseURL: string;
  /**
   * Extra origins allowed to call auth endpoints, beyond `baseURL` (which is
   * always trusted). Needed when the Studio is served from a different origin
   * than the API (e.g. the `hogsend studio` CLI against a remote instance).
   */
  trustedOrigins?: string[];
  /**
   * Self-service password-reset delivery. When provided, better-auth's
   * `/request-password-reset` + `/reset-password` endpoints are live (without a
   * `sendResetPassword` callback better-auth hard-errors `RESET_PASSWORD_DISABLED`).
   * `createHogsendClient` wires this to the engine mailer; omit it (the default)
   * for a headless instance that should not send mail (the CLI). The reset token
   * is single-use, short-TTL (15 min), constant-time compared — all better-auth
   * internals we inherit; we never re-implement them.
   */
  sendResetPassword?: SendResetPasswordFn;
  /**
   * Shared cross-replica store for better-auth's session AND rate-limit data.
   * When provided, better-auth resolves `rateLimit.storage` to "secondary-storage"
   * instead of the in-memory default — so the sign-in / request-password-reset
   * limiters are enforced GLOBALLY across Railway replicas and survive restarts,
   * not per-instance (security finding #2). `createHogsendClient` wires this to
   * the engine's shared Redis when available; omit it (the default) to keep
   * better-auth's in-memory store on a bare instance with no Redis.
   */
  secondaryStorage?: AuthSecondaryStorage;
  /**
   * Cookie-name namespace for THIS engine instance's Better Auth (passed to
   * better-auth `advanced.cookiePrefix`). Better Auth names the session cookie
   * `<__Secure->?<prefix>.session_token`; the default "better-auth" prefix
   * collides with a sibling web app's cross-subdomain SSO cookie of the SAME
   * name (e.g. course/docs on `.hogsend.com`) that the browser also delivers to
   * the Studio host — but which resolves against a DIFFERENT database → null
   * session → Studio login loop. Defaulting to "hogsend" gives the engine its
   * own namespace (`__Secure-hogsend.session_token`) so that sibling cookie is
   * simply ignored here. `cookiePrefix` only affects the cookie NAME — it is
   * orthogonal to `crossSubDomainCookies` (the Domain attribute), which the
   * engine never sets (host-only). `createHogsendClient` wires this from
   * `env.AUTH_COOKIE_PREFIX`; the default is baked in below so every call site
   * (including the headless CLI, which issues no cookie) stays aligned.
   */
  cookiePrefix?: string;
}) {
  const {
    db,
    secret,
    baseURL,
    trustedOrigins,
    sendResetPassword,
    cookiePrefix,
  } = opts;
  return betterAuth({
    basePath: "/api/auth",
    secret,
    baseURL,
    // Namespace the engine's Better Auth cookies so its session cookie no longer
    // shares a NAME with a sibling web app's `.hogsend.com` cross-subdomain SSO
    // cookie that is also delivered to the Studio host (same name, different DB
    // → null session → Studio login loop). Prefix-only; the Domain attribute
    // (crossSubDomainCookies) is left UNSET → host-only cookie. Default
    // "hogsend" → prod cookie `__Secure-hogsend.session_token`.
    advanced: {
      cookiePrefix: cookiePrefix ?? "hogsend",
      /**
       * Client-IP resolution for better-auth's rate limiter. Without this,
       * better-auth (>=1.6.25) reads only `x-forwarded-for` and — with no
       * `trustedProxies` configured — REFUSES any multi-valued XFF
       * (`getIPFromHeader`: `if (forwardedIps.length !== 1) return null`).
       * Railway's edge always sends two values (`<client>, <edge-hop>`), so on
       * Railway every request resolved to null and ALL callers collapsed onto
       * one shared per-path bucket: ten failed logins by anyone locked the
       * `/sign-in/email` path for everyone (observed live 2026-08-03 — the
       * control plane's mint-credentials retries and a customer's Studio
       * sign-ins 429'd each other).
       *
       * `x-real-ip` goes first because it is single-valued and OVERWRITTEN by
       * Railway's edge (verified empirically 2026-08-03 against a Railway echo
       * service: a spoofed `X-Real-Ip: 7.7.7.7` arrived as the caller's true
       * IP, and a spoofed `X-Forwarded-For: 6.6.6.6` was stripped too) — so a
       * direct client cannot forge it to dodge the limiter. Do NOT add
       * `x-envoy-external-address`: Railway passes it through UNTOUCHED (the
       * spoofed value survived), so trusting it would let anyone mint
       * per-request buckets and bypass rate limiting entirely.
       * `x-forwarded-for` stays as the fallback for non-Railway deploys where
       * a single-hop proxy sends a single-valued XFF.
       */
      ipAddress: {
        ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
      },
    },
    ...(trustedOrigins && trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    // Passing `secondaryStorage` flips better-auth's rate-limit storage from the
    // per-instance in-memory default to this shared store (see option doc).
    ...(opts.secondaryStorage
      ? { secondaryStorage: opts.secondaryStorage }
      : {}),
    // Tighten the brute-force budget on the credential paths — better-auth's
    // global default is a coarse 100 req / 10s per IP. Rate limiting is enabled
    // in production by default; with `secondaryStorage` above these counters are
    // shared across replicas rather than per-instance.
    rateLimit: {
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/request-password-reset": { window: 60, max: 5 },
      },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      // 🔒 Public sign-up is closed: there is NO unauthenticated network path
      // that creates a user. In better-auth 1.6.11 this guard lives INSIDE the
      // sign-up endpoint handler, so it blocks BOTH POST /api/auth/sign-up/email
      // (→ 400 EMAIL_PASSWORD_SIGN_UP_DISABLED) AND the in-process
      // `auth.api.signUpEmail`. Admins are minted only by the CLI (DB-direct)
      // and the boot env bootstrap, both via the internal adapter. Login + the
      // self-service forgot/reset endpoints are untouched (disableSignUp only
      // gates sign-up).
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // Self-service reset is enabled ONLY when a sender is injected (otherwise
      // the endpoints stay disabled rather than 500 on a missing callback).
      ...(sendResetPassword
        ? {
            // Short TTL (overrides better-auth's 3600s default). The token is
            // also single-use (deleted on consume) and constant-time compared —
            // better-auth internals we inherit.
            resetPasswordTokenExpiresIn: 60 * 15,
            // A reset kills existing sessions, so a recovered account can't be
            // ridden by a stale/leaked session.
            revokeSessionsOnPasswordReset: true,
            sendResetPassword,
          }
        : {}),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      organization({
        organizationLimit: 5,
        membershipLimit: 100,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
