/**
 * Fail-closed runtime env validation for the docs auth surface. During
 * `next build` (NEXT_PHASE is set) the runtime-only vars are absent by design,
 * so build-time placeholders are allowed; at a REAL boot a missing required var
 * THROWS loudly instead of silently signing sessions with a committed constant
 * or pointing at a localhost DB.
 *
 * Mirrors apps/course/lib/env.ts so docs runs the SAME better-auth trust root:
 * the same BETTER_AUTH_SECRET + the same DATABASE_URL (the course's user DB) is
 * what makes a session portable across `*.hogsend.com` (SSO). Only the three
 * auth-critical vars are fail-closed here; everything else the auth layer reads
 * (RESEND_API_KEY, GITHUB_*, AUTH_COOKIE_DOMAIN, HOGSEND_*) soft-skips via
 * process.env, so an unconfigured deploy degrades rather than crashes.
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
   * The SAME secret the course signs sessions with. Cross-subdomain SSO reads
   * the sibling's session cookie and verifies it against this secret, so the
   * two MUST match. Build-only placeholder; a real boot without it throws.
   */
  BETTER_AUTH_SECRET: runtimeRequired(
    "BETTER_AUTH_SECRET",
    "build-phase-placeholder-never-used-at-runtime",
  ),
  /** This app's own origin (docs). Dev default is the docs port (3005). */
  BETTER_AUTH_URL: runtimeRequired("BETTER_AUTH_URL", "http://localhost:3005"),
  /**
   * The course's user Postgres — docs points at the SAME database so a session
   * row created on either site validates on both. Docs NEVER migrates these
   * tables (the course owns their migrations); it only reads/writes the four
   * Better Auth models.
   */
  DATABASE_URL: runtimeRequired(
    "DATABASE_URL",
    "postgres://placeholder:placeholder@localhost:5432/placeholder",
  ),
};
