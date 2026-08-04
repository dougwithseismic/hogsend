/**
 * What an instance is called on the web.
 *
 * Pure, and deliberately so: the hostname is baked into every tracked email
 * link, every SMS short link, every unsubscribe URL and the signed Studio
 * cookie the moment provisioning writes `API_PUBLIC_URL`. A wrong or unstable
 * answer here is not a rendering bug, it is a dead link in mail that has
 * already been delivered. So the rules live in one tested place rather than
 * inline at the one call site that happens to need them today.
 *
 * The scheme, decided with the owner:
 *  - production is bare        → `acme.hogsend.app`
 *  - every other environment   → `acme-staging.hogsend.app`
 *
 * Tenants live on a SEPARATE registrable domain from hogsend.com, which is the
 * same split Vercel, Railway, Netlify, Render, Fly and Heroku all make. The
 * reason is not aesthetics: a cookie scoped to `.hogsend.com` is sent to every
 * subdomain at every depth, so a tenant instance under hogsend.com would
 * receive the shared docs/course SSO session cookie on every request. A
 * different registrable domain is the only thing that stops that, and
 * `refuseTenantZone` below makes it structural rather than remembered.
 *
 * Production is bare because it is the hostname customers actually see. The
 * suffix on the others is a plain label, not a deeper DNS level: a multi-level
 * name like `staging.acme.hogsend.com` would need a wildcard certificate that
 * Railway and Let's Encrypt both handle poorly.
 */

/** The environment name that gets the bare hostname. */
const BARE_ENVIRONMENT = "production";

/**
 * Slugs a tenant may not have, because we serve something there or intend to.
 *
 * This list is load-bearing in a way it would not be under a dedicated subzone:
 * tenant hostnames share `hogsend.com` with our own marketing, docs and
 * tracking surfaces, so a tenant taking `docs` or `t` would shadow a live host.
 * The first group is in use in this repo today — `t` is the tracking host, and
 * losing it would break links in already-delivered mail. The rest are held back
 * before someone needs them, which is cheaper than reclaiming one from a tenant
 * whose instance already answers there.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // In use today.
  "api",
  "app",
  "cloud",
  "course",
  "demo",
  "docs",
  "t",
  "www",
  // Held back.
  "admin",
  "assets",
  "blog",
  "cdn",
  "dev",
  "help",
  "internal",
  "mail",
  "mx",
  "ns",
  "preview",
  "production",
  "smtp",
  "staging",
  "status",
  "studio",
  "support",
  "test",
]);

/**
 * Why this zone cannot host tenants, or null when it can.
 *
 * The rule: a tenant zone must not be the SSO cookie's domain, nor anything
 * under it. RFC 6265 domain-matching is suffix-based with NO depth limit, so
 * `Domain=.hogsend.com` reaches `acme.hogsend.com` and `acme.cloud.hogsend.com`
 * alike — a deeper label buys nothing. Only a different registrable domain
 * keeps our session cookie away from code a customer controls.
 *
 * Enforced rather than documented because the failure is silent: everything
 * works, and the only symptom is a valid session token arriving in a request
 * to someone else's instance.
 */
export function refuseTenantZone(input: {
  zone: string;
  /** The SSO cookie's Domain, with or without its leading dot. */
  ssoCookieDomain?: string | null;
}): string | null {
  const cookieDomain = (input.ssoCookieDomain ?? "").replace(/^\./, "");
  if (!cookieDomain) return null;

  const zone = input.zone.replace(/^\./, "").toLowerCase();
  const scope = cookieDomain.toLowerCase();
  if (zone === scope || zone.endsWith(`.${scope}`)) {
    return `tenant zone "${input.zone}" is inside the SSO cookie domain "${input.ssoCookieDomain}": instances would receive our session cookie on every request. Tenants need a separate registrable domain.`;
  }
  return null;
}

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 30;

/** Slug shape: lowercase alphanumerics and inner hyphens. No leading digit
 * rule — `4chan` is a legal hostname label and refusing it would be arbitrary. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SlugRefusal =
  | "too-short"
  | "too-long"
  | "malformed"
  | "reserved"
  | "double-hyphen";

/**
 * Why this slug cannot be a hostname, or null when it can.
 *
 * Returns the REASON rather than a boolean so a caller can say which rule was
 * broken. A signup that refuses a name without saying why is a dead end.
 */
export function refuseSlug(slug: string): SlugRefusal | null {
  if (slug.length < SLUG_MIN_LENGTH) return "too-short";
  if (slug.length > SLUG_MAX_LENGTH) return "too-long";
  if (!SLUG_PATTERN.test(slug)) return "malformed";
  // `xn--` is the punycode prefix; a label with a double hyphen in the third
  // and fourth position is reserved by IDNA and rejected by some resolvers.
  if (slug.includes("--")) return "double-hyphen";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}

export function isUsableSlug(slug: string): boolean {
  return refuseSlug(slug) === null;
}

/**
 * The hostname for one environment.
 *
 * Throws rather than returning a bad name: every caller is about to write this
 * into DNS and into the tenant's `API_PUBLIC_URL`, and there is no sensible
 * fallback value — a hostname that is merely "close" points somewhere real and
 * wrong.
 */
export function buildInstanceHostname(input: {
  slug: string;
  environmentName: string;
  /** The zone we own, e.g. `hogsend.com`. */
  zone: string;
}): string {
  const refusal = refuseSlug(input.slug);
  if (refusal) {
    throw new Error(
      `cannot build a hostname from slug "${input.slug}": ${refusal}`,
    );
  }

  const label =
    input.environmentName === BARE_ENVIRONMENT
      ? input.slug
      : `${input.slug}-${input.environmentName}`;

  // The environment name is tenant-chosen, so it gets the same shape check the
  // slug does. Skipping it would let "prod/../etc" through into a DNS write.
  if (!SLUG_PATTERN.test(label) || label.length > 63) {
    throw new Error(
      `"${label}" is not a usable DNS label (environment name "${input.environmentName}")`,
    );
  }

  return `${label}.${input.zone}`;
}
