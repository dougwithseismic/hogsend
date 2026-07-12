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
- [x] **4.3 Reconciliation poll.** Hatchet task walking provider cursors; heals webhook gaps; idempotent with 4.2 events.
- [~] **4.4 `packages/plugin-ghl`.** Built + fixture-tested (push/webhook/poll/hydrate, fail-closed shared-secret webhooks). SEAM ASK: a GHL sandbox (PIT token + location id) for a live end-to-end pass before production; verify PIT-vs-OAuth auth reality while at it, plus the poll's `added_desc` ordering vs the `dateUpdated` cursor (review flag: a long-ago-added deal that moves stage today may not surface in the first page, so the reconcile sweep could miss it).
- [~] **4.5 `packages/plugin-attio`.** Built + fixture-tested: signed (HMAC-SHA256 `attio-signature`) thin webhooks hydrated through the REST API, currency-value + stage extraction, person-assert pushLead, best-effort email recovery via associated people. SEAM ASKS: (1) live Attio workspace pass; (2) when `feat/sources-prospects-p1` merges, fold this HTTP transport with its Attio contact source/write-back client.
- [~] **4.6 `packages/plugin-hubspot`.** Built + fixture-tested: v3-signature (or shared-secret) fail-closed webhooks, dealstage-change hydrate (amount/currency/won + contact email), search-then-create pushLead, `hs_lastmodifieddate` poll. SEAM ASK: live HubSpot sandbox pass (and confirm whether the deployment uses developer-app webhooks vs workflow webhooks).
- [ ] **4.7 `sendLeadToCrm()` helper.** DEFERRED (operator steer 2026-07-12: plugins stay as unpublished proof-of-capability; no further plugin investment). Revisit only if a deployment needs engine-side lead push.

**Phase 4b — Studio revenue surfaces** *(operator steer 2026-07-12: close the revenue loop visibly — the deals projection is the ledger; show it)*
- [x] **4b.1 Admin deals API.** `GET /v1/admin/deals` (filter by stage/provider/value/date, sorted) + `GET /v1/admin/deals/stats` (per-currency: sold revenue 30d/lifetime, open pipeline value, AOV, avg time-to-close, counts per canonical stage) over the `deals` projection.
- [x] **4b.2 Studio: revenue front and center.** Overview stats (sold 30d/lifetime, pipeline, AOV) + a Deals view — pipeline board grouped by canonical stage (the kanban) with a table fallback, filterable.
- [x] **4b.3 Contact long-tail filtering.** Admin contacts list + Studio filters: revenue ≥ X (valued-events rollup), has deal in stage, touched channel — the "find my value customers" query surface.
- *(Not building: a `defineFunnel` primitive — canonical stages + buckets cover it; revisit only if practice proves otherwise. Audience push to ad platforms + ML scoring live in Phase 8.)*

**Phase 5 — Conversion definitions + Meta CAPI**
- [x] **5.0 Verify Meta platform claims.** VERIFIED 2026-07-12 (live web sources):
  1. ✅ Offline Conversions API retired **May 14, 2025** (Graph v16 last support). All CRM/offline events ride standard CAPI — `plugin-meta-capi` must set `action_source: "system_generated"` for CRM-triggered events (`"physical_store"` for in-store).
  2. ✅ 7d/28d **view-through** windows removed from Ads Manager/Insights **Jan 12, 2026** (announced Oct 13, 2025); 2026 default = 7-day click + 1-day view (+1-day engaged). Reported conversions dropped 15–40% ecosystem-wide — our internal ledger is the client's source of truth, Ads Manager is not.
  3. ✅ Conversion Leads / CAPI-for-CRM: ≥200 leads/month, optimized stage converting **1–40%**, store the 15–17-digit Meta Lead ID. **Works for WEBSITE leads** (not just Instant Forms — Meta cites 9.5% lower cost per quality lead on website form campaigns; 21% on Instant Forms) via the Ads-Manager "Leads Funnel" stage config — map our canonical stages there; pick an optimization stage ~⅓–½ of leads complete (for solar-like funnels: `quoted`).
  4. ✅ AEM 8-event cap + prioritization removed (~June 2025); standalone AEM config UI gone; with Value Optimization, values of all eligible events are summed even for opted-out iOS users.
- [x] **5.1 `defineConversion()` (code-first) + `conversions` table.** Trigger = event name + condition (reuse condition engine / where-builder); `valueSource`; evaluation inside `ingestEvent()` post-store; fired instances recorded. MUST support restricting triggers by `user_events.source` — browser (pk_/`inapp`) events can carry a forged `value`, so money-bearing conversion points should default to server-side sources (webhook sources, `crm`, `api`).
- [x] **5.2 `defineConversionDestination()` + dispatch.** Sibling registry to destinations; `dispatches` log (unique `event_id`); durable Hatchet dispatch task with retries.
- [~] **5.3 `packages/plugin-meta-capi`.** Built + fixture-tested (deterministic event_id reuse across retries, fbc reconstruction — never fabricated, Meta-normalized hashing, per-definition event names, test_event_code). SEAM ASK: a pixel id + system-user token for a Test-Events live pass. `event_id = hash(contactId+defId+trigger)`; `fbc` from stored fbclid + arrival ts; SHA-256 em/ph; EMQ params; `action_source`; pixel-coexistence dedup documented.
- [x] **5.4 Wire + docs.** Conversions → destinations end-to-end; consumer example (journey conversion + campaign conversion).
- [x] **5.5 Meta connect — RESOLVED as token-first** *(operator decision 2026-07-12)*: Hogsend is a self-hosted framework, so the Events Manager self-generated token (Tier 0, no App Review — what `createMetaCapiDestination` already takes) IS the one-click path: the operator generates it in their own Business Manager and sets two env vars. Docs teach exactly this (`/docs/conversions/meta-ads`). The OAuth tiers (Facebook Login for Business config_id → Business-Integration System-User token; MBE embedded popup) are a multi-tenant-SaaS pattern — Hogsend never hosts other people's Meta accounts, so NOT BUILDING. Verified tier research retained in git history (8be3c87) if a managed offering ever wants it.

**Phase 5b — operator-steer follow-ups (2026-07-12: extensibility + visibility)**
- [x] **5b.1 Configurable pipeline ladder.** The canonical stage set is currently hardcoded (`lead → contacted → survey_booked → quoted → sold` + `lost`) — solar-flavored and not consumer-extensible. Make it config: `crm: { stages: [...ordered ids], quotedStage?, soldStage? }` — ranks from array order, `lost` stays terminal-negative, defaults = the current five (zero breaking, zero migration: `deals.canonical_stage` is text). Money events keep their stable names (`crm.deal_quoted` = the designated money-signal stage, `crm.deal_sold` = the designated realized stage); which stages mint them is the config. Studio board renders whatever ladder is configured. Stage maps/`resolveCanonicalStage` validate against the configured ladder.
- [x] **5b.2 Studio conversions view.** Admin endpoints + Studio surface for fired conversions and their dispatches: definition, value, contact, per-destination delivery status (pending/delivered/failed + attempts + platform receipt), destination health. The "did Meta actually get the sale?" view.
- [x] **5b.3 Deals dashboard rethink** *(operator steer 2026-07-12: the card-columns board dies at ~1000 deals; dropdown filters feel odd)*. Replace with an interactive revenue dashboard: funnel/stage-distribution graph (+ pie), revenue-over-time chart, newest-leads panel, and a paginated/searchable/sortable deals TABLE (stage as a column, not a column-of-cards). Design alongside 5b.2 — one Studio revenue surface, not two bolted pages.
- [x] **5b.4 `defineFunnel` — funnels as a code-first primitive, plural** *(operator steer 2026-07-12: "code-first but the ladder is config" + "multiple funnels")*. A funnel is authored like a journey: `defineFunnel({ id, stages, quotedStage?, soldStage?, sources: { [provider]: stageMap-with-pipeline-claims } })`, registered via `createHogsendClient({ funnels })`. Ingest resolves which funnel claims each (provider, pipeline) — exact pipeline key beats `"*"`; overlapping claims throw at boot. `deals.funnel_id` (nullable text, migration); money events + `crm.stage_changed` + outbound payloads carry `funnel_id` so conversions/journeys scope per funnel via `where`. The `crm.{stages,quotedStage,soldStage,stageMaps}` config from 5b.1 becomes sugar for a single `"default"` funnel (zero breaking; ships in the same 0.44.0). Admin stats/timeseries/list gain a `funnel` param; stats serve the funnel catalog; Studio dashboard gets a funnel switcher. Event NAMES stay engine-owned (stable catalog).

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
