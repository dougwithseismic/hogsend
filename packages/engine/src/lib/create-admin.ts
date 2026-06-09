import type { Auth } from "./auth.js";

/**
 * Shared admin-minting primitive used by BOTH the CLI's `admin create` and the
 * engine's env bootstrap. Mints a credential admin via better-auth's
 * INTERNAL ADAPTER (scrypt-identical to the running app) rather than the public
 * sign-up endpoint — which is now blocked by `disableSignUp` (see lib/auth.ts).
 *
 * Why the internal adapter (not `auth.api.signUpEmail`): in better-auth 1.6.11
 * the `disableSignUp` check lives INSIDE the sign-up endpoint handler, and
 * `auth.api.signUpEmail` dispatches through that SAME handler — so with sign-up
 * disabled it throws `EMAIL_PASSWORD_SIGN_UP_DISABLED` for the in-process API
 * too. The internal adapter is NOT subject to that guard. This mirrors exactly
 * what admin-recovery's `reset()` already does for its no-credential branch
 * (`ctx.password.hash` + `ctx.internalAdapter.createAccount({ providerId:
 * "credential" })`).
 *
 * Security invariants (acceptance gates, not preferences):
 *  - The password is hashed via `ctx.password.hash` (scrypt, identical to the
 *    app). There is NO raw SQL password write.
 *  - The password is never logged and never returned in any result object.
 *  - `emailVerified: true` because this is an operator-minted admin (CLI or
 *    boot env), not a self-service signup.
 *
 * Lives in `lib/` (reachable via the `@hogsend/engine/create-admin` subpath)
 * with a module graph that touches ONLY better-auth — it never pulls `env.ts`,
 * Hatchet, or Resend — so the CLI can import it the same way it imports
 * `createAuth` from `@hogsend/engine/auth`.
 */

/** A single admin row, no secrets. Shared with the CLI's `AdminSummary`. */
export interface CreatedAdmin {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

/** Thrown when an admin with the given email already exists. */
export class AdminAlreadyExistsError extends Error {
  constructor(public readonly email: string) {
    super(
      `An admin with email "${email}" already exists. ` +
        "Use `hogsend studio admin reset` to set a new password.",
    );
    this.name = "AdminAlreadyExistsError";
  }
}

/**
 * Create a credential admin user against a built better-auth instance. Throws
 * {@link AdminAlreadyExistsError} if the email already exists (so callers can
 * point the operator at `reset`). The unique constraint on `user.email` is the
 * backstop: a concurrent racer that slips past the pre-check throws on
 * `createUser` — callers that need idempotency should catch that.
 */
export async function createAdminUser(opts: {
  auth: Auth;
  email: string;
  name?: string;
  password: string;
}): Promise<CreatedAdmin> {
  const { auth, email, password } = opts;
  const displayName = opts.name ?? email.split("@")[0] ?? email;

  const ctx = await auth.$context;

  // Pre-check for a clear error (better-auth lowercases on lookup + create).
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) {
    throw new AdminAlreadyExistsError(email);
  }

  // scrypt hash — identical to the running app (admin-recovery.reset uses the
  // same call). NO raw SQL password write.
  const hashed = await ctx.password.hash(password);

  // `createUser` returns the bare user row (createWithHooks → the created user),
  // NOT `{ user }` — verified against better-auth@1.6.11 internal-adapter.mjs:75.
  const created = await ctx.internalAdapter.createUser({
    email,
    name: displayName,
    emailVerified: true,
  });

  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: hashed,
  });

  const createdAt =
    created.createdAt instanceof Date
      ? created.createdAt.toISOString()
      : String(created.createdAt ?? new Date().toISOString());

  return {
    id: created.id,
    email: created.email,
    name: created.name,
    createdAt,
  };
}
