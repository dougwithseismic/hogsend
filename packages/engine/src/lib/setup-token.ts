import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Logger } from "./logger.js";

/**
 * The setup token that closes the first-run land-grab on the web first-admin
 * create. The threat: `GET /v1/auth/status` reports `needsSetup: true` whenever
 * the `user` table is empty, and the Studio then POSTs straight to
 * `/api/auth/sign-up/email`. Until that first user exists, ANY anonymous network
 * visitor who reaches a fresh deploy first can claim the admin. We close that
 * race with a token the operator controls (Supabase-/GitLab-style env/log
 * gating).
 *
 * Source of truth precedence:
 * 1. `STUDIO_SETUP_TOKEN` (operator-supplied env) — deterministic; the strongest
 *    posture, set it in the deploy env.
 * 2. Auto-generated on first need when `needsSetup` is true — printed ONCE to the
 *    server log (the operator-only surface) and held stable for the process
 *    lifetime so the printed value keeps working until used. It is NEVER returned
 *    by any HTTP endpoint and NEVER sent to a client. A restart rotates the auto
 *    token (invalidating a previously-printed-but-unused one) — acceptable,
 *    arguably safer.
 */

/**
 * Lazily-computed, process-lifetime-stable holder for the auto-generated token.
 * Module-scoped (mirrors the engine's singleton pattern) so the same value is
 * returned across requests within one process. NOT exported — read it via
 * {@link resolveSetupToken}.
 */
let generatedToken: string | undefined;
let loggedFirstBoot = false;

/** Test-only: clears the generated token + first-boot log latch. */
export function resetSetupToken(): void {
  generatedToken = undefined;
  loggedFirstBoot = false;
}

/**
 * Resolve the active setup token: the operator's `STUDIO_SETUP_TOKEN` if set,
 * else a process-lifetime-stable auto-generated one (created lazily on first
 * need). Returns the secret value — callers MUST NOT log or return it over HTTP;
 * disclosure is handled exactly once by {@link logSetupTokenOnFirstBoot}.
 */
export function resolveSetupToken(envToken?: string): string {
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  if (!generatedToken) {
    // base64url, 24 random bytes — ~192 bits of entropy, URL/paste-safe.
    generatedToken = randomBytes(24).toString("base64url");
  }
  return generatedToken;
}

/**
 * Print the setup token to the server log exactly once per process, ONLY when
 * `needsSetup` is true and no operator `STUDIO_SETUP_TOKEN` is configured. This
 * is the intended operator-only disclosure surface (printing the setup token to
 * the server log on first boot is acceptable by design). It is idempotent: a
 * second call in the same process is a no-op, so we never spam the log.
 *
 * When `STUDIO_SETUP_TOKEN` IS set, we do not print its value (the operator
 * already holds it) — only a short hint that the env token is in effect.
 */
export function logSetupTokenOnFirstBoot(opts: {
  logger: Logger;
  needsSetup: boolean;
  envToken?: string;
}): void {
  const { logger, needsSetup, envToken } = opts;
  // Once a user exists, the closed-signup gate handles everything: no token is
  // generated or printed.
  if (!needsSetup) return;
  if (loggedFirstBoot) return;
  loggedFirstBoot = true;

  if (envToken && envToken.length > 0) {
    logger.info(
      "[studio] First-admin setup required. Using STUDIO_SETUP_TOKEN from env.",
    );
    return;
  }

  const token = resolveSetupToken(envToken);
  logger.warn(`[studio] First-admin setup required. Setup token: ${token}`);
  logger.warn(
    '[studio] Provide it in the Studio "create admin" form (or set STUDIO_SETUP_TOKEN).',
  );
}

/**
 * Constant-time string comparison. Guards length first (so we never throw on
 * mismatched-length buffers) and compares a fixed-length dummy when lengths
 * differ to keep timing flat regardless of which side is longer. Returns false
 * for any empty/missing input.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufB.length === 0) return false;
  if (bufA.length !== bufB.length) {
    // Compare against a same-length copy of `b` so timingSafeEqual still does
    // real work (it throws on unequal lengths); the boolean is already false.
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
