# BACKLOG — Hogsend

Ordered queue. `[ ]` not started · `[~]` shipped up to a named seam · `[x]` done
(live for users end to end). Rules and ship rights: [DECISIONS.md](DECISIONS.md).
Market picture: [MARKET.md](MARKET.md). Earlier runs: [archive/](archive/).

## Wave 1 — make the quickstart solid, then make the engine fast and extensible

| # | PRD | Status | Depends | Scope |
|---|-----|--------|---------|-------|
| 06 | [Ship compiled engine type declarations](prds/06-engine-declarations.md) | `[x] live in 0.68.0 (#684); a fresh create-hogsend@0.68.0 app type-checks, tests and builds` | — | Fresh scaffold `check-types` OOMs today; ship `dist/*.d.ts` behind the `types` condition, keep runtime on `src`. Fixes #657. |
| 07 | [Fix the correctness bugs from the engine audit](prds/07-audit-correctness.md) | `[x] live in 0.68.0 (#686)` | — | Tracking re-ingest wrote the recipient address into `external_id`; bucket mass expiry overflowed the parameter limit; per-run DB pools; serial webhook reaper; un-timed plugin fetches. |
| 08 | Public changelog catch-up (0.45 → current) | `[x] live on hogsend.com/changelog through 0.68.0 (deployed 2026-11-22)` | — | Launch bar: hogsend.com/changelog stops at 0.44.0. One user-facing entry per minor, sourced from the package CHANGELOGs. |
| 09 | [Cut the database work on every event and every send](prds/09-ingest-hot-path.md) | `[x] part A merged #688 (warm ingest 17 → 10 statements, indexed preference read); part B merged #691 (send 6 → 5, pk_ and endpoint caches, one bucket read); live in 0.68.0` | 07 | Audit A1–A4, A6–A9, A11: preference-email index, orphan-adoption gate, event-condition index + `EXISTS`, `pk_` key cache, outbound endpoint cache. Measured statement counts before/after. |
| 10 | Rate-limit headers + key management | `[~] live in 0.68.0 (#689). No rotate button in Studio or the CLI yet` | — | Launch bar: `RateLimit-*` headers on public ingest; secret vs publishable keys and rotation documented and working end to end. |
| 11 | Landing first screen leads with the wedge | `[x] live on hogsend.com 2026-11-22 (#690; mobile LCP 3.8 s → 2.1 s, real throttling)` | — | Launch bar: who / outcome / why-us + one CTA from MARKET.md; Core Web Vitals green; no overflow 360–1440 px. |
| 12 | Resolver fast path + concurrent ingest hooks | `[ ]` | 09 | Audit B1/B2: lock-free warm resolve (re-probe under lock on any change), `Promise.allSettled` for independent post-store hooks. Identity-sensitive: review panel before merge. |
| 13 | Extensibility cleanup | `[ ]` | 12 | Audit B6/B7: one generic id-keyed registry for the six provider registries, `lib/contacts.ts` split along its clusters, one subject-table list for adoption/merge/erasure/backfill. No behaviour change. |
| 14 | Refuse merging two identified users on a shared browser (#629) | `[ ]` | 12 | Implement the reserved `allowMerge: "never-identified-pair"` policy. |
| 15 | `hogsend simulate` | `[x] live in 0.68.0 (#692)` | — | Wedge: run a journey on a simulated clock and print the timeline (sends, waits, branches) for a PR comment. Builds on `@hogsend/testing`. |
| 16 | Exactly-once connector actions (#661) | `[ ]` | — | Layer-2 dedup for Telegram/Discord sends, matching email/SMS. |
| 17 | Deliverability panel | `[ ]` | — | Bounce/complaint rates against the Gmail/Yahoo bulk-sender thresholds, in Studio and `check-alerts`. |

## Launch bar (API / developer tool)

- [ ] Quickstart works when copied and pasted: `pnpm dlx create-hogsend@latest` → install → `check-types` → build → boot → health 200 (PRD 06 for `check-types`). On 0.68.0 install, `check-types`, tests and build pass; boot → health not re-checked.
- [ ] The core job works end to end for a new user: scaffold → event in → journey enrolls → email rendered and sent through a provider (test mode) with tracking.
- [x] SDK for the main language: `@hogsend/js`, `@hogsend/react`, `@hogsend/client` (published).
- [x] Landing page (hogsend.com) answers who / outcome / why-us in the first screen with one CTA, and leads with the wedge from MARKET.md.
- [x] Pricing visible without signing up (`/pricing`).
- [x] Versioned public changelog current with npm (through 0.68.0, live 2026-11-22).
- [x] Docs findability basics: sitemap (237 URLs), robots, `llms.txt`.
- [x] Rate-limit headers on public ingest endpoints (published in 0.68.0).
- [x] Key management documented and working (secret vs publishable keys, rotation) (published in 0.68.0).
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

- **Wave 2 (from the engine audit, 2026-11-21):** one tracked-send pipeline
  for every channel (C1, makes push/WhatsApp cheap); container broken into
  subsystem modules with no module-level singletons (C2); batched campaign
  send with a resumable wave cursor and render-once (B3/C3); batch-path SQL
  (B4); batched targeting estimates + a shared `paginated()` helper (B5);
  backpressure on the tracking routes (B8); a published throughput benchmark.

- Stale open PRs from July (#602, #614, #627): rebase or close.
