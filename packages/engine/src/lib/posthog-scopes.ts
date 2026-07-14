/**
 * The PostHog OAuth scope set Hogsend requests during
 * `hogsend connect posthog`. Front-loaded beyond the webhook loop's needs
 * (which requires only `hog_function:write` plus the minted webhook secret)
 * so future read/write features activate without forcing a reconnect. Every
 * name is validated against PostHog's published `scopes_supported`.
 *
 * LOCKSTEP (3 places): this constant, the CLI's `POSTHOG_SCOPES`
 * (`packages/cli/src/lib/oauth.ts` — the CLI avoids the engine ROOT import
 * because the barrel does import-time env validation, but this module is
 * dependency-free and exported as the `@hogsend/engine/posthog-scopes`
 * subpath), and the `scope` field of the hosted CIMD document
 * (`apps/docs/public/.well-known/hogsend-posthog-client.json`) — that one is
 * genuinely un-importable. PostHog gates the scopes it will grant by the CIMD
 * doc, so grep all three and keep them identical before changing any of them.
 */
export const EXPECTED_POSTHOG_SCOPES: string[] = [
  "person:read",
  "person:write",
  "project:read",
  "organization:read",
  "hog_function:read",
  "hog_function:write",
  "feature_flag:read",
  "cohort:read",
  "cohort:write",
  "query:read",
  "insight:read",
  "event_definition:read",
  "property_definition:read",
];

/**
 * PostHog's scope model is hierarchical — `X:write` implies `X:read` — and
 * the grant NORMALIZES a request for both halves down to `X:write` alone. A
 * literal set-difference against the requested list therefore reports the
 * implied `:read` halves as "missing" on every fully-successful consent
 * (e.g. person:read, hog_function:read, cohort:read). Treat a requested
 * `X:read` as satisfied when the grant carries `X:write`.
 *
 * The CLI imports this via the `@hogsend/engine/posthog-scopes` subpath —
 * single implementation, no mirror.
 */
export function posthogScopeSatisfied(
  granted: string[],
  scope: string,
): boolean {
  return (
    granted.includes(scope) ||
    (scope.endsWith(":read") &&
      granted.includes(scope.replace(/:read$/, ":write")))
  );
}
