# Revenue tracking & attribution — the plan

> Status: **in build** (autonomous loop, branch `feat/revenue-attribution`). Research basis: `docs/research/solar-on-steroids/` (blueprint + six reports + critic).

## Execution checklist

Legend: `[ ]` todo · `[~]` built-to-seam (human ask recorded) · `[x]` done. Worked strictly top-to-bottom; one commit per feature; phase-boundary simplify pass commits separately. Prose context for every item is in the phase sections below.

**Phase 1 — Value on the spine**
- [x] **1.1 `value`/`currency` on events.** Migration adding `user_events.value numeric` + `user_events.currency char(3)`; `IngestEvent` type + ingest zod schema in `@hogsend/core`/engine; `ingestEvent()` threads them; `ctx.trigger` accepts them.
- [x] **1.2 SDK + client surface.** `@hogsend/js` / `@hogsend/client` / `@hogsend/mcp` event types accept `value`/`currency`; vendored type copies synced.
- [x] **1.3 PostHog-defer reversal.** Delete the CAPI-defer NOTE in `packages/engine/src/destinations/define-destination.ts`; amend `docs/product-spec.md`; destinations fan-out (PostHog preset) passes `value`/`currency` through.
- [x] **1.4 Revenue rollup.** Per-contact revenue (SQL view or query helper) + admin stats endpoint + Studio contact-detail revenue surface.

**Phase 2 — Ad-click / touch capture**
- [x] **2.1 Click-ID capture in `@hogsend/js`.** Allowlist (`fbclid,gclid,gbraid,wbraid,ttclid,msclkid,li_fat_id,twclid,rdt_cid,epik,sccid` + `utm_*`) read at load → arrival event `{ clickIds, utm, landingPage, referrer }` on the anon identity; last-touch set persisted in the anon store; `getAttributionFields()` helper exported for hidden-field passthrough.
- [x] **2.2 Touchpoint classifier.** `@hogsend/core` helper defining the touchpoint event-class list (arrivals, `email.link_clicked`, `sms.clicked`, `email.action`, vanity arrivals, `lead.submitted`); used later by attribution + reporting.

**Phase 3 — Lead intake**
- [x] **3.1 `lead.submitted` canonical event + recipes.** Event constant + documented property shape (answers, qualification, hidden click-ID passthrough, optional `value`); consumer example webhook source in `apps/api`; docs recipes for Heyflow/Perspective/generic forms. NOT building a form engine.

**Phase 4 — `CRMProvider`** *(coordinate with `feat/sources-prospects-p1` — reuse its Attio transport + `writeBack` seam; migration numbering will collide with its `0047` — whoever merges second regenerates)*
- [x] **4.1 Contract + registry + route.** (Email-keyed identity in this slice; `crm_links` alias resolution lands with 4.2.) `defineCrmProvider()` in core; registry + container resolution; `POST /v1/webhooks/crm/:providerId` (reserve `crm` source id).
- [x] **4.2 Stage maps + deals projection.** Per-client `(pipelineId, stageId) → canonical stage` config; canonical `crm.*` valued events; `deals` projection + `crm_links` + `crm_sync_cursors` migrations; monotonic-stage rule; new event types → `WEBHOOK_EVENT_TYPES` + both vendored catalogs.
- [ ] **4.3 Reconciliation poll.** Hatchet task walking provider cursors; heals webhook gaps; idempotent with 4.2 events.
- [ ] **4.4 `packages/plugin-ghl`.** OAuth/PIT auth, contact+opportunity push, `OpportunityStageUpdate` webhook (value-in-payload), poll fallback.
- [ ] **4.5 `packages/plugin-attio`.** Reuse sources-and-prospects transport if merged; else build to seam (`[~]`) with Fake + record the ask. `record.updated` webhook → `hydrate`.
- [ ] **4.6 `packages/plugin-hubspot`.** Private-app token + `deal.propertyChange` subscription → hydrate fetch.
- [ ] **4.7 `sendLeadToCrm()` helper.** Journey/service-level push with idempotency key; docs.

**Phase 5 — Conversion definitions + Meta CAPI**
- [ ] **5.0 Verify Meta platform claims.** The §"Verify before Phase 5" list (Offline API discontinuation, window changes, Conversion Leads thresholds, AEM) against current Meta docs; record findings inline here.
- [ ] **5.1 `defineConversion()` (code-first) + `conversions` table.** Trigger = event name + condition (reuse condition engine / where-builder); `valueSource`; evaluation inside `ingestEvent()` post-store; fired instances recorded. MUST support restricting triggers by `user_events.source` — browser (pk_/`inapp`) events can carry a forged `value`, so money-bearing conversion points should default to server-side sources (webhook sources, `crm`, `api`).
- [ ] **5.2 `defineConversionDestination()` + dispatch.** Sibling registry to destinations; `dispatches` log (unique `event_id`); durable Hatchet dispatch task with retries.
- [ ] **5.3 `packages/plugin-meta-capi`.** `event_id = hash(contactId+defId+trigger)`; `fbc` from stored fbclid + arrival ts; SHA-256 em/ph; EMQ params; `action_source`; pixel-coexistence dedup documented.
- [ ] **5.4 Wire + docs.** Conversions → destinations end-to-end; consumer example (journey conversion + campaign conversion).

**Phase 6 — `@hogsend/attribution`**
- [ ] **6.1 Models + credits.** Package with pure-function models (first/last/lastNonDirect/linear/timeDecay/positionU/positionW/blended); compute ALL models at conversion time into `attribution_credits` (migration); per-definition windows.
- [ ] **6.2 Studio reporting.** Revenue-by-model per journey/campaign/channel; contact timeline with credits; model-comparison view.

**Phase 7 — Spend + ROAS**
- [ ] **7.1 Meta spend ingestion.** `ad_spend` daily rows + ad metadata via Meta Insights (Hatchet cron); ad-account config. Build to seam with a Fake if no ad-account creds (record ask).
- [ ] **7.2 ROAS reports.** CPL / cost-per-quote / cost-per-sale / ROAS by campaign/ad; admin endpoints + Studio.

**Phase 8 — Moat-wideners** *(each may spawn its own plan; build what's in-repo, seam the rest)*
- [ ] **8.1 Public proof feed.** Org-scoped public stats endpoint + embeddable feed/leaderboard with anonymity tiers.
- [ ] **8.2 Google + LinkedIn destinations.** Enhanced Conversions for Leads / offline gclid; LinkedIn CAPI.
- [ ] **8.3 GDPR lead-gen mode.** PII TTL split + consent-gated stitching (extends sources-and-prospects consent work).
- [ ] **8.4 Workspace scoping design doc.** Design-only deliverable; gates agency licensing, not core.

---

>
> Goal: Hogsend natively owns the money path — leads in → journeys/CRM → **valued events** → multi-model attribution → conversion feedback to ad platforms — with zero load-bearing dependency on PostHog or any third party. PostHog remains an optional fan-out *recipient* of our revenue data, never the pipe.

## 0. The decision this plan reverses

The product spec and `packages/engine/src/destinations/define-destination.ts` currently say ad-platform conversion forwarding (CAPI) "stays deferred to PostHog CDP; Hogsend just fires the events." **That decision is reversed.** Rationale: (a) a third party can change/remove features under us on the path that carries money — unacceptable dependency for the core value prop; (b) PostHog CDP forwards analytics events — it cannot do CRM stage detection with deal values, `fbc` reconstruction from stored click timestamps, idempotent webhook+poll dedup, or per-client stage maps; (c) revenue-per-contact computed in Hogsend is *pushed out to* PostHog via the destinations fan-out — the dependency points the other way.

Phase-1 chores: delete the defer-note in `define-destination.ts`, amend `docs/product-spec.md` §ad-platform, update the CAPI-scope stance wherever documented.

## 1. What we already have (build on, don't rebuild)

| Existing surface | Role in this plan |
|---|---|
| `ingestEvent()` + `user_events` + idempotent dedup | THE spine. Everything here is "more events, now with value" |
| Email link tracking (`/v1/t/c/:id`), SMS short links (`/s/:code`), vanity links (`/l/:slug`) + arrival attribution, open tracking | Touchpoints for owned channels — already captured as events (`email.link_clicked`, `sms.clicked`, arrivals) |
| `hs_t` token + `POST /v1/t/identify`, anon→identified fold, canonical contact key + alias merge | The identity stitch. SOS does IP heuristics; we do deterministic folds. Already hardened (0.36.1) |
| `@hogsend/js` anon identity + event capture | Where landing-page click-ID capture lives |
| `defineWebhookSource` / `defineContactSource` (sources-and-prospects) + provenance/consent posture | Lead intake + the CRM transport precedent (Attio in/out) |
| `defineDestination` + durable `emitOutbound` spine | Fan-out transport; conversion dispatch rides a sibling registry |
| `EmailProvider`/`SmsProvider`/`AnalyticsProvider` + registries + env presets | The exact pattern for `CRMProvider` and `ConversionDestination` |
| Condition engine (`evaluateCondition`, where-builder) | Conversion-definition triggers — no new matching DSL |
| Hatchet (durable tasks, crons) | CRM polling cursors, reconciliation, conversion dispatch, spend ingestion |
| Journeys / campaigns / broadcasts | The scopes conversion definitions attach to |
| Studio + admin stats + live-feed muscle (demo) | Revenue reporting + eventual public proof feed |

## 2. Design decisions (settled)

1. **`value` is first-class on events.** `user_events.value numeric NULL` + `currency char(3) NULL` (+ `IngestEvent`/zod + SDK types). Not properties-JSON: reporting is SQL aggregation and conversion defs need one uniform money field. Convention: `value` is always the *event's own* worth (deal value on `crm.deal_sold`, order total on `order.completed`).
2. **No second spine for deals.** CRM stage changes are canonical *events* through `ingestEvent()` (`crm.stage_changed`, `crm.deal_quoted`, `crm.deal_sold` — value-bearing). A thin **`deals` projection** table (current stage, value, quoted_at, sold_at, time_to_close) is materialized from those events for reporting — same pattern as `email_sends`. Monotonic-stage rule enforced at projection time (heals webhook+poll double-detection and out-of-order delivery).
3. **Click IDs are captured generically, dispatched specifically.** Capture = allowlist of URL params on arrival (config, not code). Dispatch = per-platform `ConversionDestination` providers.
4. **Reporting model ≠ optimization signal.** Internal ledger is multi-model/fractional; each ad platform receives exactly ONE full-value event per conversion definition against the best-matched click.
5. **Touchpoints are a query-time classification of events**, not a new table: arrivals, `email.link_clicked`, `sms.clicked`, `email.action`, vanity-link arrivals, form submits. A helper defines the touchpoint event-class list; the attribution engine consumes the contact's ordered, classified timeline.
6. **PII/GDPR:** optional retention mode later (Phase 8): durable analytics keyed by contact id with PII TTL, consent-gated stitching for PECR contexts. Not a v1 blocker for dogfood/product use; **is** a blocker for selling into UK lead-gen agencies — scoped, not skipped.

## 3. Phases (each independently shippable, calm-release discipline)

### Phase 1 — Value on the spine (small migration, huge leverage)
- Migration: `user_events.value` + `user_events.currency`; `IngestEvent` schema + `/v1/ingest` zod; `@hogsend/js` / `@hogsend/client` types; MCP tool schema update.
- `contact revenue` rollup: SQL view (sum of valued events per contact) surfaced in Studio contact detail + admin stats. No new tables.
- Destinations fan-out passes `value`/`currency` through (PostHog preset capture includes it; optional `revenue_total` person-property sync via `analytics.setPersonProperties`).
- Chores: delete PostHog-defer notes (spec + `define-destination.ts`).
- New event-type constants → `WEBHOOK_EVENT_TYPES` + BOTH vendored catalog copies (`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`).
- **Ship:** "events carry revenue; Stripe/any webhook source → valued event → revenue per contact/journey/campaign."

### Phase 2 — Ad-click / touch capture
- `@hogsend/js`: on load, read allowlisted params — `fbclid, gclid, gbraid, wbraid, ttclid, msclkid, li_fat_id, twclid, rdt_cid, epik, sccid` + `utm_*` — emit an **arrival event** (`$arrival` or extend the existing vanity-arrival shape) carrying `{ clickIds, utm, landingPage, referrer }` on the anon identity; persist last-touch set to the anon store for later form autofill-into-hidden-fields.
- Server: arrival `occurredAt` is the click timestamp (feeds `fbc = fb.1.<ts>.<fbclid>` later). No PII.
- Stitch: nothing new — anon→identified fold already attaches pre-identification arrivals to the contact.
- Touchpoint classifier helper in `@hogsend/core` (event-class list, used by attribution + reporting).
- **Ship:** "every paid click that lands anywhere with the snippet is a durable, stitchable touchpoint."

### Phase 3 — Lead intake recipe (docs-heavy, code-light)
- Canonical `lead.submitted` event (+ optional `value` for estimated deal size) with a documented property shape (answers, qualification fields, hidden click-ID passthrough).
- Recipes: Heyflow / Perspective / Framer form / Webflow → `defineWebhookSource` (or `defineContactSource` once sources-and-prospects merges) with hidden-field UID + click-ID passthrough; partial-submit where the vendor supports it.
- Explicitly NOT building a form/quiz engine. Revisit only after the spine proves out.
- **Ship:** "any form vendor → identified contact with full touch history."

### Phase 4 — `CRMProvider` (the loop's inbound half of money)
- Contract in `@hogsend/core` (`defineCrmProvider()`), registry + container resolution mirroring email/SMS:
  - `pushLead(input, { idempotencyKey }) → { crmId }`
  - `verifyWebhook` / `parseWebhook → CrmStageEvent[]`
  - `poll(cursor) → { events, nextCursor }` (Hatchet-scheduled reconciliation for everyone; primary path where webhooks are weak)
  - `hydrate(crmId)` for value-by-fetch CRMs
  - capabilities: `{ auth, nativeStageWebhook, valueInWebhookPayload, atomicUpsert, webhookConfigRequiresAdmin }`
- Per-client **stage map as config**: `(pipelineId, stageId) → canonical stage` (`lead|contacted|survey_booked|quoted|sold|lost`); alert (don't drop) on unmapped stages. Value may source from a different object than the stage.
- Normalized output = valued events into `ingestEvent()`; **`deals` projection** table + `crm_links` (entity ↔ crmId alias map) + `crm_sync_cursors`.
- Route: `POST /v1/webhooks/crm/:providerId` (reserve `crm` source id), registered before the `:sourceId` catch-all — same pattern as email/SMS provider webhooks.
- Plugins, in order: **GHL** (value-in-payload, agency reality), **Attio** (reuse sources-and-prospects transport; hydrate-on-webhook), **HubSpot** (webhook-then-fetch). Pipedrive/Monday/Salesforce/generic-adapter later; Salesforce is poll-first.
- Failure modes designed in: duplicate contacts (idempotency key + email/phone dedup), stage renames, multi-pipeline clients, deleted/merged deals (log, never auto-retract), token refresh fail-closed + alert, `{amount, currency}` always.
- **Ship:** "lead pushed to the client's CRM; every stage change and deal value flows back as events; pipeline/AOV/time-to-close in Studio."

### Phase 5 — Conversion definitions + Meta CAPI destination (the SOS-killer release)
- `conversion_definitions`: `{ id, scope: journey|campaign|global, name, trigger: event-name + condition (reuse condition engine / where-builder), valueSource: event.value | fixed | property-path, currency default, attributionWindow, destinations[] }`. One-or-many per campaign/journey.
- `conversions` table: fired instances `(defId, contactId, eventId, occurredAt, value, currency)` — evaluated inside `ingestEvent()` post-store (same place exit-checks run).
- `defineConversionDestination()` (sibling registry to `defineDestination` — richer contract: auth, hashed identifiers, idempotency, response log) + **`packages/plugin-meta-capi`**:
  - `event_id = hash(contactId + defId + canonical trigger identity)` — idempotent across webhook/poll double-fires and replays; `dispatches` log with response.
  - `fbc` from stored fbclid + arrival ts (never fabricated); `fbp` if present; SHA-256 em/ph; full EMQ param set; `action_source` correct for CRM-triggered events.
  - Browser-pixel coexistence: shared `event_id` dedup documented for consumers running the Meta pixel.
- Dispatch = durable Hatchet task off the outbound spine (retries, dead-letter).
- **Ship:** "declare `sold → Purchase(value)` on a campaign; Meta gets a deduped, valued server event minutes after the CRM stage flips."

### Phase 6 — `@hogsend/attribution` (the differentiator)
- Pure-function models over the contact's classified touch timeline within the definition's window: `first`, `last`, `lastNonDirect`, `linear`, `timeDecay(halfLife)`, `positionU(40/20/40)`, `positionW`, `blended(customWeights)`. (Markov/Shapley later, once volume justifies.)
- On conversion: compute ALL models, store `attribution_credits (conversionId, touchpointEventId, model, weight, creditedValue)` — dashboards switch lenses instantly, models compare side-by-side.
- Studio: revenue-by-model per journey/campaign/channel/ad; per-contact journey timeline with credits.
- **Ship:** "switchable multi-model attribution — the thing neither SOS nor any lead-gen tool ships."

### Phase 7 — Spend ingestion + ROAS
- Meta Insights poll (Hatchet cron): daily spend per campaign/adset/ad for configured ad accounts + ad metadata (`ad_id → name`); `ad_spend` daily rows; join to touchpoints via `utm_id`/click IDs.
- Reports: CPL, cost-per-quote, cost-per-sale, ROAS by campaign/ad/creative; Google spend later.
- **Ship:** "the number that sells: cost-per-SALE per ad, not cost-per-lead."

### Phase 8 — Moat-wideners (each its own mini-plan when reached)
- **Public revenue proof feed**: org-scoped public stats endpoint + embeddable live feed/leaderboard/toasts, per-client anonymity tiers (full / redacted / hidden). The SOS growth loop, productized.
- **More destinations**: Google Enhanced Conversions for Leads / offline gclid import; LinkedIn CAPI (`li_fat_id` — our B2B ICP); TikTok/Bing after.
- **GDPR lead-gen mode**: PII TTL split + consent-gated stitching + provenance ledger (extends sources-and-prospects consent work). Required before selling to UK agencies.
- **Workspace/client scoping**: per-client stage maps/funnels/feeds inside one self-hosted deploy (NOT multi-tenant cloud). Needs its own design doc — the reporting plan's `organizationId` mention is the only prior art. Decision gates the agency-enablement business model, not the product core.

## 4. Verify before Phase 5 locks (post-cutoff Meta claims from research)
1. Offline Conversions API discontinued (reported May 2025) — CAPI-only assumption.
2. View-through window removal (reported 12 Jan 2026) — reporting-window logic.
3. AEM 8-event-cap removal + value summing for opted-out iOS.
4. Conversion Leads thresholds (≥200 leads/mo, 1–40% conv within 28d, ≥1 upload/day).
5. GHL auth reality (OAuth-only vs private-integration tokens).
6. Payaca API surface (direct contact; poll-first thin adapter assumption).

## 5. Standing gotchas that WILL bite here
- New engine npm deps must mirror into `create-hogsend` template `_package.json` (consumer boot-crash class).
- New event types → `WEBHOOK_EVENT_TYPES` + both vendored catalog copies (cli + client).
- New `@hogsend/*` packages (`plugin-meta-capi`, plugin CRMs, `attribution`): follow the release skill for first publish; keep scaffold packages on the engine minor line; one release line per phase, Version Packages PR merged LAST.
- Journey replay-safety: conversion evaluation lives in `ingestEvent()` (not in journeys), so it inherits the existing idempotency story; CAPI dispatch gets its own `dispatches` unique key.
- Drizzle partial-index `onConflict`: arbiter predicate is `where` (the 42P10 trap) — relevant for `deals`/`crm_links` upserts.
