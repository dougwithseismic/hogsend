/**
 * Sending-subdomain setup guidance — one source of truth for every surface.
 *
 * A customer typing their sending domain will reach for the root
 * (`acme.com`). That works, and it is the wrong default: spam complaints
 * damage the reputation of the domain that sent the mail, and the root also
 * carries password resets, invoices and contracts. The engine recommends a
 * subdomain, states the reason once, and never blocks the root.
 *
 * The shape is structured (not a paragraph blob) so each surface renders it
 * in its own idiom — CLI coloured lines, Studio JSX — with identical words.
 */
export interface SendingDomainGuidance {
  /** Short imperative headline. */
  title: string;
  /** The reason, stated once. */
  body: string;
  /** Why it is advice and not a gate. */
  note: string;
  /** Suggested single DNS labels, best first. */
  recommendedLabels: readonly string[];
}

/** The approved copy. Frozen — surfaces render it, never mutate it. */
export const SENDING_DOMAIN_GUIDANCE: SendingDomainGuidance = Object.freeze({
  title: "Send from a subdomain",
  body: "Use notifications.acme.com rather than acme.com. Spam complaints damage the reputation of the domain that sent the mail, and your root domain also carries your password resets, invoices and contracts. A subdomain keeps that damage in one place.",
  note: "Root domains work. This is a recommendation, not a requirement.",
  recommendedLabels: Object.freeze(["notifications", "mail", "updates"]),
});

/** `acme.com` -> `notifications.acme.com`. Uses the first recommended label. */
export function exampleSendingSubdomain(domain: string): string {
  return `${SENDING_DOMAIN_GUIDANCE.recommendedLabels[0]}.${domain}`;
}

/**
 * Known multi-part public suffixes, so `acme.co.uk` counts as root-like.
 *
 * This is a short embedded list, NOT a Public Suffix List implementation.
 * The failure mode is deliberately silence: an unlisted multi-part suffix
 * (say `acme.something.gov.xx`) reads as a subdomain and produces no warning.
 * A false NEGATIVE is a missed hint; a false POSITIVE nags someone who
 * already typed `notifications.acme.com` and did the right thing.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "co.jp",
  "com.br",
  "com.mx",
  "co.in",
  "com.sg",
]);

/**
 * Whether `domain` looks like a ROOT domain (`acme.com`, `acme.co.uk`) rather
 * than a subdomain (`notifications.acme.com`) — the case where the subdomain
 * recommendation is worth surfacing. Callers warn ONLY when this is true, so
 * someone who already typed a subdomain is never nagged.
 *
 * Rule: exactly two labels, OR three labels whose last two form a known
 * multi-part public suffix (see {@link MULTI_PART_SUFFIXES} for the honest
 * limits of that list). Input is normalized (trim, lowercase, trailing dot
 * stripped); empty / whitespace / single-label input returns `false` —
 * nothing sensible to say about it.
 */
export function looksLikeRootDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;

  const labels = normalized.split(".");
  if (labels.length === 2) return true;
  if (labels.length === 3) {
    return MULTI_PART_SUFFIXES.has(labels.slice(-2).join("."));
  }
  return false;
}
