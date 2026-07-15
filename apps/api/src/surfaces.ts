import { defineSurface } from "@hogsend/engine";

/**
 * Surfaces — the external touchpoints the control room (#485) draws as
 * flow-map nodes. Each declares which slice of the event stream "is" that
 * surface; the engine's classifier stamps matching `user_events` onto the
 * `surface:<id>` node (below journeys + funnel stages, above the builtin
 * revenue node).
 *
 * The prefixes below are REAL event vocabularies emitted across the product:
 *   - `docs.*`   — the docs site (`docs.opened`, `docs.page_viewed`,
 *                  `docs.code_copied`, the nested `docs.api.*`, …)
 *   - `site.*`   — the marketing site
 *   - `demo.*`   — the hosted demo (`demo.answered`, `demo.trigger`, …)
 *   - `course.*` — the course app (`course.enrolled`, `course.lesson_completed`,
 *                  `course.completed`, …)
 *   - `checkout.*` — the commerce flow (`checkout.started`, `checkout.completed`)
 *
 * EVENT-GRADE CONTRACT: Hogsend events are MILESTONES — one per meaningful
 * state change (`site.visited` = once per session, `course.enrolled`,
 * `checkout.started`), never hit-grade telemetry. Pageview-level streams
 * belong in PostHog; duplicating them into `user_events` bloats the spine
 * every journey/exit/flow query scans, and anonymous hits can't drive
 * journeys anyway. The flow map reads transitions BETWEEN surfaces, so one
 * session-grade event carries the same edge a hundred pageviews would.
 *
 * Tiers place each surface in its lifecycle column: docs / site / demo are
 * ACQUISITION (how people arrive), the course is ACTIVATION (learning the
 * product), checkout is REVENUE. The `app` surface is the consumer's own
 * server: product events the API emits (signups, feature usage) carry the
 * `api` ingest source rather than a shared prefix, so it matches on source —
 * and because source resolves AFTER prefixes, the prefixed surfaces above win
 * for anything that also happens to arrive server-side.
 */

export const site = defineSurface({
  id: "site",
  name: "Marketing site",
  tier: "acquisition",
  match: { eventPrefix: "site." },
});

export const docs = defineSurface({
  id: "docs",
  name: "Docs",
  tier: "acquisition",
  match: { eventPrefix: "docs." },
});

export const demo = defineSurface({
  id: "demo",
  name: "Demo",
  tier: "acquisition",
  match: { eventPrefix: "demo." },
});

export const course = defineSurface({
  id: "course",
  name: "Course",
  tier: "activation",
  match: { eventPrefix: "course." },
});

export const checkout = defineSurface({
  id: "checkout",
  name: "Checkout",
  tier: "revenue",
  match: { eventPrefix: "checkout." },
});

export const app = defineSurface({
  id: "app",
  name: "Product app",
  tier: "activation",
  // The consumer's own server: signups, feature usage, and other product
  // events emitted through the API. `source: "api"` is pipeline provenance,
  // AND-able with a `where` refinement if ever needed.
  match: { source: "api" },
});

// Traffic SOURCES as first-class nodes (Doug, 2026-07-15): the map should
// show where people come from, not just where they go.

export const campaignTraffic = defineSurface({
  id: "campaign-traffic",
  name: "Campaign traffic",
  tier: "acquisition",
  display: "source",
  // The SDK auto-fires exactly one `campaign.arrived` per utm/click-id
  // landing — so this node IS paid/campaign arrivals, feeding whatever
  // surface the visitor lands on next. (Lane colouring still works: the
  // live lane cache is captured before classification.)
  match: { events: ["campaign.arrived"] },
});

export const referral = defineSurface({
  id: "referral",
  name: "Referrals",
  tier: "acquisition",
  display: "source",
  // The referral system's events (`referral.visited`, `referral.converted`,
  // …) — invite-driven arrivals as their own source node.
  match: { eventPrefix: "referral." },
});

export const surfaces = [
  site,
  docs,
  demo,
  course,
  checkout,
  app,
  campaignTraffic,
  referral,
];
