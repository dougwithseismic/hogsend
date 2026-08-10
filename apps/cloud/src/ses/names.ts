/**
 * What this stack calls its own AWS resources.
 *
 * One module, because these names are a CONTRACT between PRDs rather than a
 * detail of any one of them: PRD 06 mints the tenant and the configuration set
 * under these names, PRD 03's relay addresses every send with them, and PRD 08
 * reads reputation by them. Two files deriving the same string independently is
 * how a send lands on a tenant that no reputation sweep is watching.
 *
 * Both are derived from the environment id alone, and that is the point
 * (DECISIONS §3.2): stable, opaque, and carrying NO customer-controlled string
 * into an AWS resource name.
 */

/** DECISIONS §3.2 — one SES tenant per Cloud environment, named for it. */
export function sesTenantName(environmentId: string): string {
  return `env-${environmentId}`;
}

/**
 * The configuration set every send for this environment is made under. It
 * carries the event destination PRD 05 publishes bounces and complaints
 * through, so a send made WITHOUT it produces no webhook at all.
 *
 * Deliberately the SAME opaque id as the tenant. AWS namespaces the two
 * resource types separately, so there is no collision, and an operator reading
 * a send log then has one identifier to correlate rather than two that differ
 * by a suffix nobody remembers.
 */
export function sesConfigurationSetName(environmentId: string): string {
  return `env-${environmentId}`;
}
