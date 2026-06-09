import { createDatabase, user } from "@hogsend/db";
// Narrow subpath imports: `@hogsend/engine/auth` re-exports only `createAuth`
// (lib/auth.ts) and `@hogsend/engine/create-admin` only `createAdminUser`
// (lib/create-admin.ts) — both module graphs touch just better-auth +
// @hogsend/db. Importing from the engine barrel (`@hogsend/engine`) would
// eagerly run the env validation in env.ts (requires BETTER_AUTH_SECRET /
// HATCHET_CLIENT_TOKEN at module-eval time) and pull Hatchet/Resend/PostHog —
// heavy and wrong here.
import { createAuth } from "@hogsend/engine/auth";
import {
  AdminAlreadyExistsError,
  createAdminUser,
} from "@hogsend/engine/create-admin";

/**
 * Shell-gated Studio admin recovery primitive (PostHog/GitLab/Rails-style
 * management command). Constructs its own better-auth instance against the DB
 * and uses better-auth's SERVER API so password hashing is identical to the
 * running app. NO HTTP, no running API required.
 *
 * Security invariants (these are acceptance gates, not preferences):
 *  - Every password write goes through better-auth's server API (scrypt via
 *    `ctx.password.hash` + the internal adapter). Public sign-up is closed
 *    (`disableSignUp`), so create() uses the internal adapter too, NOT
 *    `auth.api.signUpEmail`. There are NO raw SQL password writes here, ever.
 *  - Passwords are never logged and never returned in any result object.
 *  - `list` selects only non-secret columns (id/email/name/createdAt) — never
 *    the account password/hash.
 *  - Gated by holding both `DATABASE_URL` and `BETTER_AUTH_SECRET` (i.e. DB
 *    reach + the app secret). There is no HTTP fallback.
 */

/** A single admin row, as surfaced by `list` (no secrets). */
export interface AdminSummary {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AdminRecovery {
  /**
   * Create a new admin user via better-auth's INTERNAL ADAPTER (scrypt-hashes,
   * writes the `user` + `account` rows). NOT via public sign-up — that is now
   * blocked by `disableSignUp`; the internal-adapter path is not subject to that
   * guard and is correct for the trusted CLI. Throws a clear, non-secret error
   * if the email already exists (points at `reset`).
   */
  create(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<AdminSummary>;
  /**
   * Set the password for an existing admin. Mirrors better-auth's own
   * `resetPassword` route: hash via `ctx.password.hash`, then either
   * `updatePassword` (if a credential account exists) or `createAccount` a
   * credential account. Optionally revokes existing sessions so an old leaked
   * session cannot survive a recovery reset. Throws if no user matches.
   */
  reset(input: {
    email: string;
    password: string;
    revokeSessions?: boolean;
  }): Promise<AdminSummary>;
  /** List existing admins (no secret columns selected, ever). */
  list(): Promise<AdminSummary[]>;
  /** Close the pg pool so the CLI process exits cleanly. */
  close(): Promise<void>;
}

/** Thrown when required env (DB URL / app secret) is missing. */
export class AdminRecoveryConfigError extends Error {}

/**
 * Resolve a single admin row from a better-auth `User`-shaped object into the
 * non-secret summary shape.
 */
function toSummary(u: {
  id: string;
  email: string;
  name: string;
  createdAt: Date | string;
}): AdminSummary {
  const created =
    u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt;
  return { id: u.id, email: u.email, name: u.name, createdAt: created };
}

/**
 * Build an {@link AdminRecovery} bound to a DB + app secret. Constructs a
 * minimal better-auth instance directly (NOT `createHogsendClient`, which boots
 * Hatchet/Resend/PostHog and is heavy + irrelevant here).
 *
 * `baseURL` is only used by better-auth for cookie/URL config and is irrelevant
 * to these headless server calls; it defaults to localhost.
 */
export function createAdminRecovery(opts: {
  databaseUrl: string;
  secret: string;
  baseURL?: string;
}): AdminRecovery {
  if (!opts.databaseUrl) {
    throw new AdminRecoveryConfigError("DATABASE_URL is required.");
  }
  if (!opts.secret) {
    throw new AdminRecoveryConfigError("BETTER_AUTH_SECRET is required.");
  }

  const { db, client } = createDatabase({ url: opts.databaseUrl });
  const auth = createAuth({
    db,
    secret: opts.secret,
    baseURL: opts.baseURL ?? "http://localhost:3002",
  });

  return {
    async create({ email, password, name }) {
      try {
        // Shared scrypt-correct minting via the internal adapter (NOT public
        // sign-up, which `disableSignUp` now blocks). `CreatedAdmin` is the same
        // non-secret shape as `AdminSummary` (id/email/name/createdAt string).
        return await createAdminUser({ auth, email, name, password });
      } catch (err) {
        // Re-message a duplicate without leaking internals; never echo the
        // password. `createAdminUser` throws AdminAlreadyExistsError with a
        // message that already points at `reset`.
        if (err instanceof AdminAlreadyExistsError) {
          throw new Error(err.message);
        }
        if (err instanceof Error) {
          throw new Error(`Failed to create admin: ${err.message}`);
        }
        throw err;
      }
    },

    async reset({ email, password, revokeSessions }) {
      const ctx = await auth.$context;
      const found = await ctx.internalAdapter.findUserByEmail(email, {
        includeAccounts: true,
      });
      if (!found) {
        throw new Error(
          `No admin with email "${email}". ` +
            "Use `hogsend studio admin create` to create one.",
        );
      }

      // Hash via better-auth's server API — scrypt, identical to the running
      // app. NO raw SQL password write.
      const hashed = await ctx.password.hash(password);
      const hasCredential = found.accounts?.some(
        (a) => a.providerId === "credential",
      );
      if (hasCredential) {
        await ctx.internalAdapter.updatePassword(found.user.id, hashed);
      } else {
        await ctx.internalAdapter.createAccount({
          userId: found.user.id,
          providerId: "credential",
          accountId: found.user.id,
          password: hashed,
        });
      }

      // A recovery reset should not leave old (possibly leaked) sessions alive.
      if (revokeSessions) {
        await ctx.internalAdapter.deleteSessions(found.user.id);
      }

      return toSummary(found.user);
    },

    async list() {
      // Plain Drizzle read — only non-secret columns. The password/hash column
      // lives on `account` and is never selected here.
      const rows = await db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt,
        })
        .from(user);
      return rows.map((r) => toSummary(r));
    },

    async close() {
      await client.end();
    },
  };
}
