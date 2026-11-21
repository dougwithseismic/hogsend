# BACKLOG — Hogsend

Ordered queue. `[ ]` not started · `[~]` shipped up to a named seam · `[x]` done
(live for users end to end). Rules and ship rights: [DECISIONS.md](DECISIONS.md).
Market picture: [MARKET.md](MARKET.md). Earlier runs: [archive/](archive/).

## Wave 1 — make the quickstart solid, then make the engine fast and extensible

| # | PRD | Status | Depends | Scope |
|---|-----|--------|---------|-------|
| 06 | [Ship compiled engine type declarations](prds/06-engine-declarations.md) | `[~] (building since 2026-11-21, autopilot)` | — | Fresh scaffold `check-types` OOMs today; ship `dist/*.d.ts` behind the `types` condition, keep runtime on `src`. Fixes #657. |

## Launch bar (API / developer tool)

- [ ] Quickstart works when copied and pasted: `pnpm dlx create-hogsend@latest` → install → `check-types` → build → boot → health 200 (PRD 06 for `check-types`).
- [ ] The core job works end to end for a new user: scaffold → event in → journey enrolls → email rendered and sent through a provider (test mode) with tracking.
- [x] SDK for the main language: `@hogsend/js`, `@hogsend/react`, `@hogsend/client` (published).
- [ ] Landing page (hogsend.com) answers who / outcome / why-us in the first screen with one CTA, and leads with the wedge from MARKET.md.
- [x] Pricing visible without signing up (`/pricing`).
- [ ] Versioned public changelog current with npm (page stops at 0.44.0; npm is at 0.67.0).
- [x] Docs findability basics: sitemap (237 URLs), robots, `llms.txt`.
- [ ] Rate-limit headers on public ingest endpoints.
- [ ] Key management documented and working (secret vs publishable keys, rotation).
- [ ] Core Web Vitals green on the landing page.
- [ ] No horizontal overflow 360–1440 px on landing, pricing, docs home.
- n/a Status page — no hosted service is live (Cloud offline).
- n/a Payments / checkout — open-source engine; Cloud billing exists but Cloud is offline.

## Needs you

- **Production API and Cloud are offline.** `api.hogsend.com` and
  `cloud.hogsend.com` time out: the Railway project `Hogsend` has no
  `production` environment and the `hogsend-cloud` project no longer exists.
  If that teardown was deliberate, nothing to do (the docs site and npm are the
  live surfaces). If not, say so and I'll restore the dogfood API from the
  recipe (it adds Railway usage cost). Unblocks: the dogfood journeys and Cloud.

## Parking lot

- Stale open PRs from July (#602, #614, #627): rebase or close.
