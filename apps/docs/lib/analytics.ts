import posthog from "posthog-js";

/**
 * Product analytics. Events are anonymous by default — `capture()` never
 * carries PII (no emails, no names) and is keyed on PostHog's own anonymous
 * distinct_id. The ONE exception is `identify()`: with the visitor's explicit
 * consent (the required terms checkbox in EmailCapture) it sets email/name as
 * person properties on the contact's PostHog profile. Identity itself still
 * lives in Hogsend (the ingest API); PostHog gets semantic events keyed on its
 * anonymous distinct_id until that consented identify.
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
  /** Live-demo opener — "what brings you here", captured anonymously before
   * the email step so the later identify() stitches it to the contact; with
   * `{ intent, placement }`. */
  INTENT_SELECTED: "docs.intent_selected",
  /** "Who are you" answer — post-signup steps, the anonymous built-for chips,
   * AND the live-demo seat step, distinguished by `{ placement }`; with
   * `{ role }`. */
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
  /** Resend/Postmark toggle in code samples AND the live-demo provider step,
   * with `{ provider, placement }`. */
  PROVIDER_SELECTED: "docs.provider_selected",
  /** "Email me this template" request, with `{ template }` (no email here —
   * the address goes to the Hogsend ingest API only). */
  SAMPLE_REQUESTED: "docs.sample_requested",
  /** Event-name checker on /event-naming, with `{ value, valid, rule }`. */
  NAME_CHECKED: "docs.name_checked",
  /** Pricing calculator interaction, with `{ contacts, sends }`. */
  CALCULATOR_USED: "docs.calculator_used",
  /** Referral landing page (/hey/[name]) viewed, with `{ personalised }` —
   * the name in the URL is PII-adjacent and never sent. */
  REFERRAL_VIEWED: "docs.referral_viewed",
  /** Live-demo qualifier answer — ONE event per question, captured anonymously
   * before the email step, with `{ question, answer, placement }` where
   * `question ∈ {posthog_usage, posthog_depth, lifecycle, building}` and
   * `answer` is that question's closed value. One event, many properties: it
   * replaces the per-question captures for the qualifyFirst flow only. */
  QUALIFIER_SELECTED: "docs.qualifier_selected",
  /** Setup-week hand-raise (non-PostHog offer answered "yes") — fired
   * server-side to the Hogsend ingest API carrying the email, so the dogfood
   * lead alert can route on it. NOT a client `capture()`; the constant lives
   * here so the event name stays the single source of truth. */
  SETUP_INTERESTED: "docs.setup.interested",
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
 * at subscribe time as the top-level `anonymousId` so the engine keys the
 * contact on it and the browsing session joins the contact's PostHog person
 * with no merge. Pre-consent (memory persistence) the id lives only until the
 * next full page load; once the visitor consents and persistence is upgraded
 * to localStorage+cookie, the same id is durable across loads.
 */
export function getDistinctId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (!posthog.__loaded) return undefined;
  return posthog.get_distinct_id();
}

/**
 * identify — identifies the PostHog session under the Hogsend contact key (a
 * stable opaque id, NOT the email: emails change and would fragment identity,
 * so the key stays the anchor). The same key is what the engine's outbound
 * destinations emit as `userId` and what `hs_t` email-click tokens resolve to,
 * so the subscribing session, the contact's email-lifecycle events, and
 * post-click visits all converge on ONE PostHog person.
 *
 * `personProperties` (email, name) are written to that person's profile via
 * PostHog `$set`. This is the single place we hand PII to PostHog, and only
 * because the caller holds the visitor's explicit consent at the point of
 * capture (the required terms checkbox + privacy-policy link in EmailCapture).
 * With anonymousId threading the contact key EQUALS the browser anon id, so
 * this `identify(contactKey)` is a self-alias no-op for identity — it carries
 * only the consented person properties. The durable cross-session/-device
 * stitch lives server-side (the `/v1/t/identify` alias in posthog-boot.tsx),
 * not here.
 */
export function identify(
  distinctId: string,
  personProperties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  if (!posthog.__loaded) return;
  posthog.identify(distinctId, personProperties);
}

/**
 * DURABLE_PERSISTENCE — the post-consent persistence mode. `localStorage`
 * keeps the distinct id across full page loads (so the visitor is one stable
 * person) and the `+cookie` half lets the first-party reverse proxy carry it
 * server-side too.
 */
export const DURABLE_PERSISTENCE = "localStorage+cookie" as const;

/**
 * Consent ledger key. Written to localStorage ONLY after explicit consent, so
 * the pre-consent visitor stays strictly cookieless (no storage write at all).
 * Read at boot so a returning consented visitor starts durable immediately.
 */
const CONSENT_KEY = "hs_consent";

/**
 * hasConsented — whether this device previously granted analytics-persistence
 * consent. Safe on the server (returns false) and tolerant of storage being
 * unavailable (private mode, blocked) — best-effort, defaults to no-consent.
 */
export function hasConsented(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

/**
 * grantConsent — the consent-boundary upgrade (MF-8 steps 3+4). The CALLER
 * must already have (1) read `posthog.get_distinct_id()` once → `id` and (2)
 * forwarded that same `id` as `anonymousId` on subscribe BEFORE calling this,
 * because `set_config` may rotate the stored id. Here we:
 *   (3) flip persistence to durable localStorage+cookie (no re-init), and
 *   (4) `identify` with the EXACT same `id` captured in step (1) — a self-alias
 *       no-op that holds only because we pass the pre-upgrade id, not a fresh
 *       `get_distinct_id()` read.
 * The consent decision is persisted so the next visit boots straight durable.
 * `personProperties` (email, name) ride the identify as the consented $set.
 */
export function grantConsent(
  id: string,
  personProperties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, "granted");
  } catch {
    // Private mode / storage blocked: the upgrade still applies for this
    // session; only the cross-visit durable boot is lost. Best-effort.
  }
  if (!posthog.__loaded) return;
  posthog.set_config({ persistence: DURABLE_PERSISTENCE });
  posthog.identify(id, personProperties);
}

/**
 * Session identity — set by EmailCapture after a successful subscribe.
 * Deliberately a plain in-memory object (no cookies, no storage) regardless of
 * the PostHog persistence mode; it survives client-side navigation but not a
 * full page load. It backs the in-session `/api/deploy-clicked` forward, not
 * cross-session identity (that is the server-side alias).
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
