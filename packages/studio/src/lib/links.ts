/**
 * External documentation links surfaced in Studio (onboarding card, empty
 * states, sidebar). Centralized here so they're trivial to update if the docs
 * site reorganizes. Paths target docs.hogsend.com — adjust in one place.
 */
const DOCS = "https://docs.hogsend.com";

export const links = {
  docs: DOCS,
  quickstart: `${DOCS}/docs/getting-started`,
  recipes: `${DOCS}/docs/recipes`,
  journeys: `${DOCS}/docs/guides/journeys`,
  buckets: `${DOCS}/docs/guides/buckets`,
  events: `${DOCS}/docs/guides/events`,
  templates: `${DOCS}/docs/guides/email`,
} as const;
