# Build blueprint: the "on steroids" lead-gen machine, from scratch

Synthesis of primary browser recon (`recon.md`) + six Opus research reports (`findings/`) + a completeness-critic pass (`findings/critic.md`). Written 2026-07-12.

**The one-line conclusion:** Solar on Steroids is a £1.5–3.5M/yr bootstrapped agency whose defensible IP is not ads or funnels — it's a closed loop: *funnel session UID → lead → CRM pipeline stage → deal value → valued CAPI event back to Meta*, wrapped in a public live revenue-proof feed. They sell that loop to other agencies for £40–100k per bespoke install, and they have already parked the platform brand (`onsteroids.com`, `api.onsteroids.com`, Convex + Clerk-style org IDs). **Crucially, the multi-model attribution engine you want does not exist at SOS** — they run first-touch cross-session stitching + a single last-click-style valued CAPI event. The multi-model engine, per-campaign conversion-point definitions, and a generic multi-CRM plugin layer are the *gap*, not the copy.

---

## 1. How SOS actually operates (verified)

### The five-part machine
1. **Trust layer** — per-client page collecting self-shot selfie video testimonials; those become ad creative.
2. **Meta video ads** — client-owned ad account (agency operates under a rules-based discipline framework, "no emotion in the account"); 20–50 campaigns × 5–10 variants from one shoot day (400GB–1TB footage → up to 500 creatives); 20+ ads live simultaneously; four creative types (Education [best], Engagement, Offer, Social Proof); shoot cadence tied to spend (<£20k/mo → quarterly; £20–40k → 2×/quarter; >£40k → monthly). Video filters for margin: educated viewers accept premium pricing; hooks repel price-shoppers ("Looking for cheap solar? Go find someone else!").
3. **Quiz funnels on Perspective** (rented; SOS is their #1 agency partner; 30k+ leads, £200k/mo traffic). First question = zero-friction hardest qualifier ("Do you own your home?" — doubled conversion, halved CPL). ~15 latent questions, 6–9 shown via branching. Late optional free-text field = strongest buy signal (CPL +£5, CPA −£100). Dynamic headlines matched to ad intent (7–8% static baseline → big lifts). Autofill deliberately disabled. Portfolio funnel CR ~5.5% (2–3% at launch → 7–8% tuned).
4. **"On steroids API"** — the attribution loop (below).
5. **CRM integrations** — GHL, HubSpot, Salesforce, Monday, Pipedrive, Payaca, "bespoke if API is available."

### The attribution loop (their real IP)
Four datapoints: initial submission info, session tracking, pipeline stage/status, deal value.

```
ad click (fbclid) → Perspective funnel (uid minted, UTMs + click IDs captured)
  → lead POST into SOS ledger (sosId) → push to client CRM (crmId)
  → stage-change detection via BOTH webhooks AND polling
  → on quote/sale: read deal value, look up uid → fbclid + ad_id
  → reconstruct fbc, fire CAPI `lead_sold` { value } → Meta optimizes for buyers
```

- Tracked fields (verbatim): `appeal, product, ipAddress, dealValue, sold, quoted, pipelineStage, perspectiveId, funnelStartPage, sosId, crmId, clientId, dateCreated, lastUpdated, utm_medium, utm_id, utm_campaign, utm_source, postcode, phone, email, name`. Three external IDs (`sosId` canonical + `perspectiveId`/`crmId` aliases) = the key modeling lesson.
- GDPR: tracking by UID; **no PII beyond 29 days** (two-table split: durable non-PII analytics + TTL'd PII); clients control publication granularity.
- Cross-session stitch: FB click with no form fill → later organic visit converts → credited to first touchpoint (via returning uid / ipAddress / funnelStartPage).
- Their own Kimble essay admits the model captures ~45% of true influence (£180k tracked vs £221k more cited-but-untracked).

### Real economics (their public stats API, fetched 2026-07-12)
49,805 leads → 6,263 quotes (12.6%) → 1,132 sales (18% of quotes; 2.3% of leads), £16.4M tracked sales revenue, £85.8M quote value, AOV ≈ £14.5k, ~£2M/mo attributed. (The site's "£102M" = quote value + sales revenue summed; the "£25M+ sales" header vs £16.4M tracked implies pre-system/manual numbers — flagged, unresolved.)

### Commercial model
- **Three revenue lines:** undisclosed setup fee (funds shoot + funnel + 50–300 ads + audit) + **monthly retainer engineered to EXCEED ad spend** (~25% pricier than competitors; fee decoupled from spend volume) + client-funded ad spend (£2,500/mo floor). Fourth line: the £40–100k system license.
- **Demand controls:** qualification floor (≥8 installs/mo), capacity cap (~6 new clients/mo, waitlist), location management instead of exclusivity (density/affluence-based, protect existing clients).
- **Contract:** monthly rolling, no tie-in, 30-day notice — retention risk shifted onto delivered performance, which is what forces the attribution discipline.
- **Origin story as sales weapon:** started pure-performance (covered ad spend themselves, nearly went broke at £18k/mo exposure, switched to retainer Dec 2024); now runs selective "performance bets" on lighthouse logos (Activ8: 5×, CPL −79%).
- **Team ~40:** 15+ editors, videographers, media buyers (£100k+/mo portfolios), CRO, systems architect + API dev (ClickUp/Make/Zapier + the attribution pipeline), CSMs.
- **ROI framing:** target ~20× ROAS; ~£500 max CAC on a £10k system; benchmark AJ Renewables 25× ROAS, CPL £39–67.
- US expansion Apr 2026 (Northeast; $1,600 two-sided referral fee). Windows vertical already staged (`/call/uk-windows`).

---

## 2. The market gap (what to build vs what exists)

Every layer exists somewhere; **nobody ships the bundle**:

| Capability | Best incumbent | Gap |
|---|---|---|
| Multi-model attribution (first/last/linear/time-decay/position/blended, switchable per campaign) | Fragmented heuristics (Hyros first/last/linear/U; SegMetrics 4 models; CustomerLabs+BigQuery) | **No lead-gen product exposes all models as switchable first-class lenses** |
| Conversion-point definitions per campaign/journey | Cometly (hard-coded B2B lifecycle stages); GHL (own CRM only) | **The core primitive — `{campaign, crmStage → event, valueSource}` config across arbitrary CRMs — is not a shipped product anywhere** |
| Value/revenue tracking | Well covered (Wicked LTV, Cometly+Stripe, WhatConverts quote/sale values) | SOS twist: value at *quote AND sale* + `time_to_close` |
| Multi-CRM plugin sync (webhook + poll) | AnyTrack (GHL recipe), Cometly (HubSpot/SF) | **Biggest structural whitespace — nobody normalizes stage changes across many CRMs with poll fallback** |
| Public revenue-proof feed | Nobody | **SOS's most copy-worthy, least-copied idea** |

Pricing benchmarks: mid-market attribution SaaS $500–1,500/mo (Cometly $750–1,495, Hyros $230–1,499, Wicked $500–800); setup fees $300–15k are normal; GHL white-label $97–497/mo. SOS's bespoke license: £40–100k.

**Why the loop stays open:** N×M CRM integration surface, cross-session identity stitching, and long sales cycles that break browser click windows (forcing CRM-triggered server events). Everyone closed it narrowly (GHL in its walled garden, Cometly for B2B SaaS, Hyros for call funnels, Triple Whale for DTC). Generic multi-CRM + multi-model + proof feed = unclaimed.

---

## 3. The build: architecture

Eight components. Steps 1–5 replicate SOS; 6–8 exceed them.

### 3.1 Identity & tracking edge (own this; SOS's exact mechanism is unverified — we author it)
- **First-party UID** (`uid`) minted at first touch by our snippet/edge middleware; stored in a first-party cookie (+ localStorage mirror). Every subsequent touch appends to the touchpoint ledger under that uid.
- **Click capture at landing:** on any landing with `fbclid`/`gclid`/`ttclid`/`msclkid`/UTMs, write a server-side `click` touchpoint row **with timestamp** (required later to reconstruct `fbc = fb.1.<click_ts_ms>.<fbclid>` — never fabricate without a real click).
- **Identity joins:** (a) uid cookie continuity; (b) deterministic email/phone match at form submit (identify → contact); (c) conservative fallback stitch (IP + landing page within a short window) flagged as `inferred`. Conflicting stitches resolve to the *earlier* first touch; keep the audit trail.
- **Third-party-funnel passthrough:** if the form layer is rented (Heyflow/Perspective), uid + click IDs ride as hidden fields; if params get stripped, an interstitial redirect on our domain captures them first (same pattern as the existing Hogsend link tracker).

### 3.2 Funnel/form layer (rent first, build later)
Build-vs-buy verdict from the research: **the form engine is the commodity; the attribution spine is the moat — draw the line exactly where SOS drew it.**
- **Fastest path: Heyflow** (native Meta CAPI, partial-submit capture, carrier-level phone validation, conditional webhooks, built-in A/B — ~80% of the capture list). Perspective is prettier/white-label-stronger but forced SOS to build their tracking layer.
- **If/when we build the form engine**, minimum spec: mobile-first tap-native steps; branching (~15 latent → 6–9 shown); dynamic headline/hero/CTA templated off URL params with a variant registry + per-variant conversion tracking; optional-field completion tracked as a lead-quality attribute; autofill-disable toggle; inline phone/email validation; step-level event stream (not just terminal submit); hidden-field auto-capture of UTMs/click IDs.
- Funnel doctrine to encode as defaults: zero-friction qualifying first question; no "free" language; postcode/property-type gates; late free-text intent field.

### 3.3 Canonical ledger (the data model)
```
contacts            canonical person (PII in a separate TTL-able table)
sessions            uid, first/last seen
touchpoints         uid, contact_id?, ts, type (ad_click|visit|form_start|form_submit|email|sms|call),
                    channel/source, utm_*, click_ids jsonb, ad_id/adset/campaign, landing_page, inferred?
leads               lead_id (canonical), contact_id, client_id, funnel_id, answers jsonb, submitted_at
external_ids        (entity_type, entity_id, system, external_id)  -- crmId/perspectiveId/… aliases
stage_events        APPEND-ONLY: lead_id, pipeline_id, from_stage, to_stage, canonical_stage,
                    value?, currency?, occurred_at, observed_at, source (webhook|poll), raw jsonb
deals               lead_id, value {amount,currency}, quoted_at, sold_at, time_to_close, status
conversion_defs     client_id, scope (campaign/journey/global), name,
                    trigger {canonical_stage | event}, value_source {crm_field|fixed|formula},
                    destinations [meta_capi|ga4|internal…], attribution overrides (window, model)
conversions         def_id, lead_id, occurred_at, value  (one row per fired conversion point)
attribution_credits def-scoped: conversion_id × touchpoint_id × model → weight, credited_value
dispatches          event_id UNIQUE, destination, def_id, payload_hash, status, response
```
Load-bearing rules distilled from research + critic:
- **Canonical internal key + alias map** (survive CRM/funnel-tool swaps without losing history).
- **`stage_events` append-only** makes webhook+poll idempotent and replayable; canonical stage advances monotonically (a late `quoted` after `sold` is ignored).
- **Dispatch idempotency:** deterministic `event_id = hash(lead_id + canonical_stage [+ def_id])` so the same transition seen by webhook AND poll fires once (critic's week-one blocker).
- **PII split:** durable non-PII analytics keyed by uid (unbounded) + PII table with configurable TTL (SOS uses 29 days). Late-closing deals then match on `fbc`/`fbp` only — acceptable, document it.

### 3.4 CRM plugin layer (`CRMProvider` — mirrors Hogsend's `EmailProvider`/`AnalyticsProvider` pattern)
```ts
interface CRMProvider {
  meta: { id: string; name: string };
  capabilities: {
    auth: "oauth" | "apiKey" | "hmac";
    nativeStageWebhook: boolean;      // SF false; others true-ish
    valueInWebhookPayload: boolean;   // GHL, Pipedrive true; HubSpot/Attio/Monday false
    atomicUpsert: boolean;            // GHL, SF(extId), Attio true
    webhookConfigRequiresAdmin: boolean;
  };
  pushLead(input: LeadInput, opts: { idempotencyKey: string }): Promise<{ crmId: string }>;
  verifyWebhook(req): Promise<void>;
  parseWebhook(payload): Promise<CanonicalFunnelEvent[]>;
  poll(cursor: string | null): Promise<{ events: CanonicalFunnelEvent[]; nextCursor: string }>;
  hydrate(crmId: string): Promise<{ dealValue?: Money; stage: string }>;
}
```
- **Canonical stages:** `lead → contacted → survey_booked → quoted → sold` (+ `lost`). Per-client **stage map keyed on `(pipelineId, stageId)`** — config-as-data, so onboarding = mapping task, not deploy. Alert on unmapped stages.
- **Webhook-primary + reconciliation poll for everyone** (SOS's own log shows both). Salesforce = poll-primary unless the org admin enables CDC/Platform Events.
- **Value extraction split:** value-in-payload (GHL `monetaryValue`, Pipedrive v2 full-object webhooks) vs value-by-fetch (`hydrate` for HubSpot/Attio/Monday/SF). Value may live on a different object than the stage (invoice vs opportunity) — mapping must allow it. Always `{amount, currency}`.
- **Failure modes designed in:** duplicate contacts (idempotency key + email/phone dedup + own crmId↔leadId map), stage renames, multi-pipeline clients, deleted/merged deals (log, don't retract), webhook loss/ordering (monotonic stages + poll heals), token refresh (fail closed + alert).
- **Long tail:** a generic configurable adapter (endpoints/auth/field-paths + `transform → CanonicalFunnelEvent`) — structurally `defineWebhookSource` — covers "bespoke if API available." Payaca's real API is undocumented publicly (name-collides with Paya Connect payments) → poll-first thin adapter until confirmed. Keap (seen live on Kimble's site) is exactly this long-tail class.

### 3.5 Conversion points + value tracking (the product's atomic unit)
A **conversion-point definition** per campaign/journey: `{ scope, trigger: stage|event, value_source, destinations, attribution window/model }`. Examples: `survey_booked → "Schedule" (no value)`, `quoted → "QuoteIssued" (value = quote value)`, `sold → "Purchase" (value = deal value)`. Multiple defs per campaign is a requirement (Doug's spec) and nobody ships it generically — this is the config surface SOS's technical VA hand-writes per client.

### 3.6 Attribution engine (the differentiator — SOS does NOT have this)
- Input: ordered touchpoints for the contact within the definition's lookback window + the conversion (value).
- **Models as pure functions** over the same touch list: `first`, `last`, `last non-direct`, `linear`, `time-decay(halfLife)`, `position/U (40/20/40)`, `W-shaped`, `custom-weight blended`; later `Markov removal-effect` / `Shapley` once volume allows (SOS-scale ≈ 6k quotes is enough).
- **Compute all models at conversion time; store credits per model** — switching lenses in the dashboard is then instant, and models can be compared side-by-side (blended view) instead of pretending one number is truth.
- **Decouple reporting from optimization:** the internal ledger is fractional/multi-model; **Meta still receives exactly one full-value event per conversion def against the best-matched click** (that's what its optimizer wants). Optionally later: value-weighted per-touch events. Add geo-holdout/incrementality testing as the honesty layer (SOS's own essay admits ~45% capture).

### 3.7 Ad-platform feedback (Meta first, Google later)
- **CAPI, not Offline Conversions API** (reported discontinued May 2025 — verify, §6). Send `Lead` at submit (browser pixel + server event, shared `event_id` — dedup keys on `event_name+event_id` only), custom events at quote/sale with `value`+`currency`.
- **`fbc` reconstruction** from stored fbclid + original click ts; hash email/phone (SHA-256), never hash fbc/fbp; maximize EMQ params while PII is inside the TTL window.
- **Conversion Leads performance goal:** map lead stages in Events Manager; thresholds reported as ~≥200 leads/mo, optimized stage converting 1–40% within 28 days, upload ≥1×/day (verify). Solar's long cycle sits at the edge — which is why the internal ledger (not Ads Manager) must be the source of truth for the client.
- **Storage of the Meta lead/click identifiers** (`ad_id`, campaign/adset, Meta Lead ID where present) on the touchpoint at capture time.

### 3.8 Proof feed + dashboards (the growth loop)
- Client dashboard: leads/quotes/sales, cost-per-quote/sale, time-to-close, model-comparison view.
- **Public embeddable proof feed**: org-scoped public API (SOS: `api.onsteroids.com/v1/public/:org/stats` + realtime feed via Convex), per-client anonymity levels (full / redacted "Mutant#XXXX" / hidden), live "sold a £13,302 system" toasts, leaderboard. Every client site becomes a billboard; the attribution ledger IS the marketing asset. Essentially no competitor ships this.

### GDPR posture (UK-first)
Copy the SOS shape, gate the sharp edge: UID-based tracking, PII TTL (29d default, configurable), sub-processor list for DPIA, per-client publication controls. **Unresolved legal question (critic #5): lawful basis for pre-consent cross-session stitching + CAPI dispatch under UK GDPR/PECR** — design a consent-gate mode (stitch only post-consent; PECR treats the cookie/UID as requiring consent) and get an ICO-guidance read before locking defaults. Consent + provenance ledger at submission (source page, ts, IP, UTM set, checkbox state) retained independently of the CRM.

---

## 4. Hogsend mapping (what exists vs what's new)

| Blueprint component | Hogsend today | Delta |
|---|---|---|
| Identity edge / uid | `@hogsend/js` anon identity, cookie model, link tracker + `hs_t` identity token, vanity links w/ arrival attribution | Extend: click-ID capture + click-ts log, touchpoint ledger writes |
| Ingestion | `ingestEvent()` spine, `user_events`, `defineWebhookSource` | Touchpoints are richer than events (click IDs, ad ids) — new table or typed event class |
| CRM plugins | `EmailProvider`/`AnalyticsProvider`/`defineConnector` patterns to clone | **New: `CRMProvider` + registry + per-client stage maps; Hatchet for polling cursors + reconciliation** |
| Conversion defs | Journey/campaign primitives, broadcasts | **New: conversion_definitions config + evaluation on stage_events** |
| Attribution engine | — | **New package (e.g. `@hogsend/attribution`): pure-function models + credit ledger** |
| CAPI dispatch | Durable `emitOutbound` spine exists (needs transform layer — already a known follow-up) | **New destination: Meta CAPI (+ GA4 later) with event_id idempotency** |
| Dashboards/feed | Studio, admin stats, live-feed muscle from demo work | **New: public proof-feed surface + embeds** |
| Nurture (TOF play) | Journeys, email/SMS/Discord/Telegram channels, digest/throttle | Already the moat SOS *lacks* — their TOF thesis explicitly requires automated nurture |

Notable synergy: SOS's top-of-funnel doctrine ("only 3% are in-market; TOF at ~10% CPL works only with automated nurture") is precisely a Hogsend journey — the attribution product and the lifecycle engine sell each other.

---

## 5. Business model options

- **(A) SaaS** — $500–1,500/mo mid-market, metered on tracked revenue/sessions; demo-gated (nobody free-trials attribution); $1–5k onboarding attach.
- **(B) Agency (SOS clone)** — highest per-client revenue (retainer > ad spend + setup fee + client-funded spend ≥£2.5k/mo), needs the content factory; doesn't scale as software.
- **(C) Agency-enablement license** — the uncontested one: install the system in agencies (SOS proves willingness-to-pay at £40–100k bespoke; undercut with a repeatable platform at e.g. $15k setup + $500–1,500/mo per agency, each agency reselling to its vertical clients). Precedents (GHL white-label, WhatConverts white-label) validate the motion but neither licenses a revenue-first attribution + CAPI + proof-feed engine.

**Recommendation:** build the product once on Hogsend rails; prove it in one vertical the SOS way (a handful of hand-held clients or one partner agency = the dogfood + case-study engine); lead commercially with (C) and keep (A) as the self-serve on-ramp. The vertical wedge beyond solar: home services (windows/HVAC/roofing) — SOS is already moving (uk-windows) and attribution there is documented as underused.

Build order: **(1)** identity edge + ledger → **(2)** CRMProvider (GHL + HubSpot + Attio first: GHL = agency reality, Pipedrive/GHL = value-in-payload easy wins, Attio = modern wedge) → **(3)** conversion defs + CAPI dispatcher → **(4)** attribution engine + model-comparison dashboard → **(5)** proof feed → **(6)** form engine (only after the spine earns it).

---

## 6. Verify-before-relying-on (post-cutoff / unsourced claims)

Load-bearing claims the agents report that need primary-source verification before implementation decisions:
1. Meta removed 7-day/28-day **view-through** windows from Ads Manager/Insights (reported 12 Jan 2026).
2. AEM 8-event-cap + prioritization removal; value summing for opted-out iOS users.
3. Offline Conversions API discontinued May 2025 (migration-to-CAPI story is real; exact date matters for messaging).
4. Conversion Leads thresholds (≥200 leads/mo, 1–40% conversion within 28 days, ≥1 upload/day).
5. GHL v1 API keys fully deprecated (private-integration tokens may still exist).
6. Payaca (UK) actual API surface — requires direct/partner contact.
7. AJ Renewables "~£400 cost per sale" — unsourced; verified figures are 25× ROAS, CPL £39–67.
8. SOS "£25M+ sales" vs £16.4M tracked sales revenue vs £102M (quotes+sales) — marketing reconciliation unknown.
9. All SOS superlatives ("#1", "first", "zero churn") are first-party; no third-party reviews exist.

Open design decisions (Doug): consent-gate default (GDPR §3.8), form layer rent-vs-build sequencing (Heyflow first?), whether this lives as Hogsend packages vs a separate product brand, and the first vertical/partner-agency for the dogfood loop.
