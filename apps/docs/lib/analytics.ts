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
  /** "Get your Discord invite" CTA in the live demo — the cross-channel step
   * (join → /link → a "you linked your Discord" item lands in the same bell),
   * with `{ placement }`. Anonymous; the actual link match happens server-side
   * in the dogfood when the visitor runs /link with their signed-up email. */
  DISCORD_LINK_CLICKED: "docs.discord_link_clicked",
  /** Any link to the hosted Studio demo (demo.hogsend.com), with
   * `{ placement }`. Besides the anonymous PostHog capture, the click is
   * captured through the docs' own Hogsend client, so it lands in the dogfood
   * ingest on the visitor's contact (`hs_anon_id`, or the signed-in contact) —
   * see TrackDemoClick in components/analytics/track.tsx. */
  DEMO_LINK_CLICKED: "docs.demo_link_clicked",
  /** A playbook play opened, with `{ slug, category }`. Besides the anonymous
   * PostHog capture it fires through the docs' own Hogsend client, so which
   * plays a visitor reads lands in the dogfood ingest as an intent signal —
   * see PlayViewTracker in components/playbook/play-tracking.tsx. */
  PLAY_VIEWED: "docs.play_viewed",
  /** A ladder-CTA rung on a play clicked, with `{ rung, slug }` where
   * `rung ∈ {self-serve, managed, dfy}`. Dual-leg like PLAY_VIEWED. */
  PLAY_CTA_CLICKED: "docs.play_cta_clicked",
  /** The "copy for your agent" button on a play — the play copied as an
   * implement-this prompt, with `{ slug }`. The strongest intent signal a
   * play emits. */
  PLAY_PROMPT_COPIED: "docs.play_prompt_copied",
  /** Setup-week hand-raise (non-PostHog offer answered "yes") — fired
   * server-side to the Hogsend ingest API carrying the email, so the dogfood
   * lead alert can route on it. NOT a client `capture()`; the constant lives
   * here so the event name stays the single source of truth. */
  SETUP_INTERESTED: "docs.setup.interested",
  /** Referral-link visit (/hey?ref=<key>) — fired server-side to the Hogsend
   * ingest API with the referrer's opaque contact key in `{ referred_by }`
   * and the visitor's PostHog distinct_id as `anonymousId`, so the dogfood
   * can attribute the conversion (Discord /link) back to the referrer. The
   * friend's display NAME from the URL is NEVER sent — only the ref token and
   * the anon id travel. NOT a client `capture()`; the constant lives here so
   * the event name stays the single source of truth. Note: unlike the rest of
   * the enum this uses the engine's `object.action` dot form, matching the
   * cross-repo shared contract verbatim. */
  REFERRAL_VISITED: "referral.visited",
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
 * getAnonymousDistinctId — the distinct_id ONLY while the session is still
 * anonymous; undefined once `identify()` has run. After identify the
 * distinct_id IS the Hogsend contact key — an identity, not a browser id —
 * and sending it as a top-level `anonymousId` would mint a phantom contact
 * whose anonymous_id equals a real contact's key (ingest is kind-scoped by
 * design and must never fold across identity kinds). Callers keying an
 * ANONYMOUS ingest arm use this; callers that want "whatever the current
 * distinct_id is" (identify stitching, consent audit) keep `getDistinctId`.
 */
export function getAnonymousDistinctId(): string | undefined {
  const id = getDistinctId();
  if (id === undefined) return undefined;
  // posthog-js keeps $device_id at the pre-identify distinct_id; divergence
  // means identify() has re-keyed the session under the contact key.
  return id === posthog.get_property("$device_id") ? id : undefined;
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
 * Consent ledger key. Written to localStorage ONLY after an explicit decision,
 * so the undecided visitor stays strictly cookieless (no storage write at
 * all). Read at boot so a returning consented visitor starts durable
 * immediately. Values: "granted" | "denied" (remembering a refusal is itself
 * strictly necessary, so the one small write on deny is allowed).
 */
const CONSENT_KEY = "hs_consent";

export type ConsentStatus = "granted" | "denied" | null;

/**
 * getConsentStatus — this device's recorded decision, or null when the
 * visitor has never been asked / never answered (the banner shows on null).
 * Safe on the server (returns null) and tolerant of storage being unavailable
 * (private mode, blocked) — best-effort, defaults to undecided.
 */
export function getConsentStatus(): ConsentStatus {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

/**
 * hasConsented — whether this device previously granted analytics-persistence
 * consent. Safe on the server (returns false) and tolerant of storage being
 * unavailable (private mode, blocked) — best-effort, defaults to no-consent.
 */
export function hasConsented(): boolean {
  return getConsentStatus() === "granted";
}

/**
 * Consent-change subscribers — the banner, the Hogsend storage gate, and any
 * future surface that must react the moment the decision flips. Same-document
 * only (the `storage` event doesn't fire in the writing tab); dispatched by
 * the three writers below.
 */
type ConsentListener = (status: ConsentStatus) => void;
const consentListeners = new Set<ConsentListener>();

export function onConsentChange(listener: ConsentListener): () => void {
  consentListeners.add(listener);
  return () => consentListeners.delete(listener);
}

function writeConsent(status: "granted" | "denied"): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, status);
  } catch {
    // Private mode / storage blocked: the in-session effect still applies;
    // only the cross-visit memory of the decision is lost. Best-effort.
  }
  for (const listener of consentListeners) listener(status);
}

/**
 * grantStorageConsent — the banner's "allow" path: storage consent WITHOUT
 * identification (no PII is in play — that stays exclusive to the EmailCapture
 * checkbox via `grantConsent`). Persists the decision, then flips PostHog to
 * durable persistence via `set_config` — the in-memory distinct_id carries
 * over, so the session's anonymous history becomes this device's one durable
 * person. The Hogsend SDK side reacts through `onConsentChange` (the gated
 * storage adapter in consent-storage.ts).
 */
export function grantStorageConsent(): void {
  if (typeof window === "undefined") return;
  writeConsent("granted");
  if (!posthog.__loaded) return;
  posthog.set_config({ persistence: DURABLE_PERSISTENCE });
}

/**
 * denyConsent — the banner's "stay cookieless" path. Records the refusal so
 * the banner never re-asks, and leaves everything exactly as it was: PostHog
 * stays on "memory" persistence, the Hogsend SDK stays on its non-persisting
 * adapter. Nothing to tear down because nothing was ever written.
 */
export function denyConsent(): void {
  if (typeof window === "undefined") return;
  writeConsent("denied");
}

/**
 * withdrawConsent — flips a previously-granted device back to cookieless.
 * Records "denied", then reverses the durable footprint: PostHog drops back to
 * "memory" persistence and `reset()` clears its localStorage/cookie state
 * (including the `.hogsend.com` distinct_id cookie) and rotates the id. The
 * Hogsend `hs_anon_id` cleanup happens in the gated storage adapter via
 * `onConsentChange`. Callers wanting an audit event must send it BEFORE
 * calling this, while the durable id still exists.
 */
export function withdrawConsent(): void {
  if (typeof window === "undefined") return;
  writeConsent("denied");
  if (!posthog.__loaded) return;
  // reset() first (it clears the persisted state), then drop to memory so
  // nothing durable is re-minted afterwards.
  posthog.reset();
  posthog.set_config({ persistence: "memory" });
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
  writeConsent("granted");
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
