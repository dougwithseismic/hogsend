/**
 * The PostHog OAuth scope set Hogsend requests during
 * `hogsend connect posthog`. Front-loaded beyond the webhook loop's needs
 * (which requires only `hog_function:write` plus the minted webhook secret)
 * so future read/write features activate without forcing a reconnect. Every
 * name is validated against PostHog's published `scopes_supported`.
 *
 * LOCKSTEP (3 places — no single importable source of truth, the CLI has no
 * engine dependency): this constant, the CLI's `POSTHOG_SCOPES`
 * (`packages/cli/src/lib/oauth.ts`), and the `scope` field of the hosted CIMD
 * document (`apps/docs/public/.well-known/hogsend-posthog-client.json`).
 * PostHog gates the scopes it will grant by the CIMD doc, so grep all three
 * and keep them identical before changing any of them.
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
