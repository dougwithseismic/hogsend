/**
 * Fail-closed runtime env validation. During `next build` (NEXT_PHASE is set)
 * the runtime-only Railway vars are absent by design, so build-time placeholders
 * are allowed; at a REAL boot a missing required var THROWS loudly instead of
 * silently falling back to an insecure default (e.g. signing sessions with a
 * committed public constant, or pointing at a localhost DB).
 *
 * The migrator (scripts/migrate.mjs) reads DATABASE_URL directly and does NOT
 * import this module, so the runtime throw never blocks the pre-deploy migration.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

function runtimeRequired(name: string, buildPlaceholder: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isBuildPhase) return buildPlaceholder;
  throw new Error(
    `${name} is required at runtime but is not set — refusing to start with an insecure default.`,
  );
}

export const env = {
  /**
   * Used ONLY during `next build`. A real boot without BETTER_AUTH_SECRET throws,
   * so sessions/magic-link tokens are never signed with a committed constant.
   */
  BETTER_AUTH_SECRET: runtimeRequired(
    "BETTER_AUTH_SECRET",
    "build-phase-placeholder-never-used-at-runtime",
  ),
  BETTER_AUTH_URL: runtimeRequired("BETTER_AUTH_URL", "http://localhost:3006"),
  DATABASE_URL: runtimeRequired(
    "DATABASE_URL",
    "postgres://placeholder:placeholder@localhost:5432/placeholder",
  ),
};
