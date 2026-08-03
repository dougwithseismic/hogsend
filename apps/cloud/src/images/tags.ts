/**
 * Image NAMES, in one place.
 *
 * Two facts they have to hold: a docker repository name is lowercase-only (both
 * inputs below are uuids or semver, so this is a constraint we satisfy rather
 * than sanitise), and a tag must identify exactly ONE artifact — so a tenant
 * image is tagged by BUILD id, never by environment or "latest". A mutable tag
 * would make "which code is this stack running" unanswerable the moment a
 * second publish landed.
 */

/** The stock scaffold image a freshly provisioned stack boots on. */
export function defaultImageTag(engineVersion: string): string {
  return `hogsend-default:${engineVersion}`;
}

/** One tenant build's image. Immutable: the tag IS the build id. */
export function tenantImageTag(input: {
  environmentId: string;
  buildId: string;
}): string {
  return `hogsend-env-${input.environmentId}:${input.buildId}`;
}
