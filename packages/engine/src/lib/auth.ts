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
}) {
  const { db, secret, baseURL, trustedOrigins, sendResetPassword } = opts;
  return betterAuth({
    basePath: "/api/auth",
    secret,
    baseURL,
    ...(trustedOrigins && trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    // Passing `secondaryStorage` flips better-auth's rate-limit storage from the
    // per-instance in-memory default to this shared store (see option doc).
    ...(opts.secondaryStorage
      ? { secondaryStorage: opts.secondaryStorage }
      : {}),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
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
