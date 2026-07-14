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

export const surfaces = [site, docs, demo, course, checkout, app];
