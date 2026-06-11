import posthog from "posthog-js";

/**
 * Anonymous product analytics — never pass PII to PostHog (no emails, no
 * names). Identity lives in Hogsend (the ingest API); PostHog gets semantic
 * events keyed on its own anonymous distinct_id.
 *
 * One event, many properties: prefer a single event name with a
 * discriminating property (e.g. `page_viewed { area, section }`) over a
 * proliferation of event names — it keeps PostHog insights and downstream
 * Hogsend bucket criteria composable.
 */
/**
 * Naming convention — `context.object_action`: lowercase snake_case, a
 * single dot scoping the event to its context (`docs.` = hogsend.com), and
 * past-tense verbs from a closed list (viewed, clicked, copied, submitted,
 * selected, provided). Same real-world action = same event name everywhere:
 * `docs.deploy_clicked` here is the same event the ingest API receives.
 */
export const AnalyticsEvent = {
  /** Every route view, with `{ area, section, slug, path }`. */
  PAGE_VIEWED: "docs.page_viewed",
  /** Any Railway deploy CTA, with `{ placement }`. */
  DEPLOY_CLICKED: "docs.deploy_clicked",
  /** Any CopyButton press, with `{ snippet }` (first 80 chars, never PII). */
  CODE_COPIED: "docs.code_copied",
  /** Email capture form submitted (UI funnel step — the domain fact is the
   * server-side `docs.subscribed`), with `{ placement, product_notes }`. */
  CAPTURE_SUBMITTED: "docs.capture_submitted",
  /** "Who are you" answer — post-signup steps AND the anonymous built-for
   * chips, distinguished by `{ placement }`; with `{ role }`. */
  ROLE_SELECTED: "docs.role_selected",
  /** Post-signup website provided (the URL itself goes to Hogsend only). */
  WEBSITE_PROVIDED: "docs.website_provided",
  /** An FAQ accordion row opened, with `{ question }`. */
  FAQ_OPENED: "docs.faq_opened",
  /** A showcase/code tab selected, with `{ tab }`. */
  TAB_SELECTED: "docs.tab_selected",
  /** A docs search ran (server-side, anonymous), with `{ query }`. */
  SEARCH_PERFORMED: "docs.search_performed",
  /** Homepage use-case picker, with `{ use_case }`. */
  USE_CASE_SELECTED: "docs.use_case_selected",
  /** Integrations stack picker, with `{ source }`. */
  STACK_SELECTED: "docs.stack_selected",
  /** Resend/Postmark toggle in code samples, with `{ provider }`. */
  PROVIDER_SELECTED: "docs.provider_selected",
  /** "Email me this template" request, with `{ template }` (no email here —
   * the address goes to the Hogsend ingest API only). */
  SAMPLE_REQUESTED: "docs.sample_requested",
  /** Event-name checker on /event-naming, with `{ value, valid, rule }`. */
  NAME_CHECKED: "docs.name_checked",
  /** Pricing calculator interaction, with `{ contacts, sends }`. */
  CALCULATOR_USED: "docs.calculator_used",
} as const;

export type AnalyticsEventName =
  (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/**
 * capture — thin wrapper over PostHog that no-ops when analytics is
 * uninitialised (no NEXT_PUBLIC_POSTHOG_KEY, or running on the server).
 * Components use this instead of importing posthog-js directly.
 */
export function capture(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!posthog.__loaded) return;
  posthog.capture(event, properties);
}

/**
 * getDistinctId — PostHog's current anonymous distinct_id, or undefined when
 * analytics is off. Sent to the Hogsend ingest API (NOT the other way round)
 * at subscribe time so the anonymous browsing session can later be joined to
 * the contact. With memory persistence the id only lives until the next full
 * page load — it identifies the subscribing session, nothing more.
 */
export function getDistinctId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!posthog.__loaded) return undefined;
  return posthog.get_distinct_id();
}

/**
 * Session identity — set by EmailCapture after a successful subscribe.
 * Deliberately a plain in-memory object (no cookies, no storage) so the
 * site stays strictly cookieless; it survives client-side navigation but
 * not a full page load, which is exactly the consent posture we want.
 */
export const sessionIdentity: { email?: string } = {};

/**
 * trackDeployClick — the deploy CTA is the activation event. Always captures
 * the anonymous PostHog event; when the visitor subscribed earlier in this
 * session, also forwards `docs.deploy_clicked` to the Hogsend ingest API so
 * the docs-subscriber journey can skip its day-2 nudge.
 */
export function trackDeployClick(placement: string): void {
  capture(AnalyticsEvent.DEPLOY_CLICKED, { placement });

  const email = sessionIdentity.email;
  if (!email) return;
  fetch("/api/deploy-clicked", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    // Fire-and-forget: the redirect to Railway must never wait on this.
    keepalive: true,
  }).catch(() => {});
}
