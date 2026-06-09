import { randomBytes } from "node:crypto";
import { user } from "@hogsend/db";
import type { HogsendClient } from "../container.js";
import { AdminAlreadyExistsError, createAdminUser } from "./create-admin.js";

/**
 * Boot-time first-admin bootstrap. Replaces the old web setup-token land-grab:
 * with public sign-up disabled (lib/auth.ts `disableSignUp`), admins are minted
 * ONLY by the CLI (DB-direct) or this in-process boot path — there is NO
 * unauthenticated network path that creates a user.
 *
 * Contract (all conditions must hold to mint):
 *  - `STUDIO_ADMIN_EMAIL` is set (unset ⇒ no-op; CLI is then the only path).
 *  - The `user` table has ZERO rows (idempotent: never mints over an existing
 *    user, never rotates/re-prints anything once an admin exists).
 *
 * Password resolution:
 *  - `STUDIO_ADMIN_PASSWORD` if set (NEVER logged).
 *  - else an auto-generated strong password (base64url, >=16 chars) PRINTED
 *    ONCE to the server log — the single intended secret-logging exception,
 *    clearly labelled "shown once". The operator should rotate it immediately
 *    via the self-service forgot/reset flow (retained, revokes sessions).
 *
 * Concurrency: two API replicas booting on a fresh DB could both pass the
 * 0-rows check; the `user.email` unique constraint makes the loser's
 * `createUser` throw — caught here and treated as "already created" (no-op, no
 * log of the loser's generated password). Invariant preserved: exactly one
 * admin, no unauthenticated path.
 *
 * Never blocks boot beyond a clear fatal when an explicitly-set password is too
 * weak — that validation lives in env.ts (`STUDIO_ADMIN_PASSWORD.min(8)`), so
 * by the time we run the password is already known-valid or auto-generated.
 */
export async function bootstrapAdminFromEnv(opts: {
  client: HogsendClient;
}): Promise<void> {
  const { db, auth, env, logger } = opts.client;

  const email = env.STUDIO_ADMIN_EMAIL;
  if (!email) return;

  // Idempotency gate: only mint into a fresh DB (zero users). Reuses the same
  // zero-check the old /v1/auth/status used.
  const existing = await db.select({ id: user.id }).from(user).limit(1);
  if (existing.length > 0) return;

  // Auto-generate when no explicit password: base64url(18 bytes) ⇒ 24 chars,
  // ~144 bits of entropy. We only log the generated value, never an env one.
  const explicit = env.STUDIO_ADMIN_PASSWORD;
  const password = explicit ?? randomBytes(18).toString("base64url");

  try {
    const admin = await createAdminUser({ auth, email, password });

    if (!explicit) {
      // The ONE intended secret-logging exception (auto-generated only). Shown
      // once — never re-printed (we only reach here on a zero-user DB).
      logger.warn(
        `[studio] First admin created: ${admin.email}. ` +
          `Generated password (save this, shown once): ${password}`,
      );
      logger.warn(
        "[studio] Rotate it now via the Studio forgot-password flow " +
          "(or set STUDIO_ADMIN_PASSWORD).",
      );
    } else {
      logger.info(`[studio] First admin created from env: ${admin.email}.`);
    }
  } catch (err) {
    if (err instanceof AdminAlreadyExistsError) {
      // A concurrent replica won the race (or the user appeared between the
      // zero-check and the insert). No-op — never log the generated password.
      logger.debug(
        "[studio] First-admin bootstrap skipped: an admin already exists.",
      );
      return;
    }
    // A unique-violation surfaced by the adapter (not our pre-check) is the same
    // race; treat any duplicate-key error as "already created". Anything else is
    // unexpected — surface it without leaking the password.
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint|already exists/i.test(message)) {
      logger.debug(
        "[studio] First-admin bootstrap lost a creation race; skipping.",
      );
      return;
    }
    logger.error("[studio] First-admin bootstrap failed.", { error: message });
  }
}
