# Research: attribution-system

## Reverse-Engineering the "On Steroids API" — Attribution & Data System

### Executive summary

Solar on Steroids (SOS) has quietly built the thing most performance agencies only talk about: a closed-loop, revenue-based attribution system that optimizes Meta ad spend on **cost-per-quote and cost-per-sale**, not cost-per-lead. It is not exotic technology — it is a disciplined stitching of five commodity pieces (a quiz-funnel session tracker, a lead ledger, a CRM sync via webhook + poll, a `uid`↔`fbclid` join, and a Meta Conversions API dispatcher) into one continuous spine. The genius is operational, not algorithmic: they close the loop from ad click → funnel submission → CRM pipeline stage → signed deal value → back into Meta's optimizer, and they do it with a GDPR-safe UID design that lets them run a public revenue leaderboard. They then **sell the system itself for £40k–£100k+VAT**. This report reconstructs that architecture precisely enough to rebuild, specifies the exact Meta features/gotchas a rebuild must handle, and shows where a genuinely superior multi-model attribution engine would slot in (SOS today does first-touch stitching + last-click CAPI feedback — not true multi-model).

---

### 1. Reconstructed architecture (end-to-end spine)

**Stage A — Ad click & session capture (on the Perspective funnel).** A Meta ad click lands on a Perspective quiz funnel carrying `?fbclid=…&utm_source=…&utm_medium=…&utm_campaign=…&utm_id=…&utm_content=…`. SOS deliberately builds long, "horrible but powerful" tracking URLs (verbatim), and deliberately **disables autofill** to preserve qualification friction (their cost-per-lead essay argues frictionless forms let "toddlers" submit — quality dilution is the enemy). At page load, SOS mints a first-party **`uid`** (the log shows `uid:a7f3`) and persists it, along with `fbclid` and all UTMs, into a first-party store keyed to that browser/session. This is the critical move: `fbclid` is captured into a **server-side / first-party record, not just browser memory**, so it survives for reconstruction weeks later. Perspective natively passes UTMs and supports Facebook Pixel + hidden fields + webhooks/Zapier/Make, which is exactly the surface SOS needs.

**Stage B — Lead POST (submission info).** On form completion Perspective fires a webhook containing the answers plus the hidden `uid`/`fbclid`/UTM fields. SOS records "initial submission info" (datapoint #1) into its own ledger — the tracked-field list is verbatim: `appeal, product, ipAddress, dealValue, sold, quoted, pipelineStage, perspectiveId, funnelStartPage, sosId, crmId, clientId, dateCreated, lastUpdated, utm_medium, utm_id, utm_campaign, utm_source, postcode, phone, email, name`. Note the three foreign keys — `perspectiveId` (funnel record), `sosId` (their own canonical key), `crmId` (the record in the client's CRM) — which is how one human is joined across three systems. `funnelStartPage` + `ipAddress` are the session-stitch keys (Stage F).

**Stage C — CRM sync.** SOS pushes the lead into the client's CRM (GoHighLevel, HubSpot, Salesforce, Monday, Pipedrive, Payaca, or a bespoke API) and stores the returned `crmId`. This is the handoff into the installer's sales process where quotes get raised and deals get closed.

**Stage D — Stage-change detection (webhook + poll, belt-and-braces).** This is datapoint #3 ("pipeline stage/status") and the hardest part. The simulated system log shows BOTH `POST /webhooks/crm` (push) AND `crm.poll — checking for stage changes` with a `crm.poll delay:2341ms` (pull). They run both because CRM webhooks are unreliable/inconsistent across the six+ CRMs — webhooks give low latency when they fire, polling guarantees eventual consistency when they don't. A stage transition (`status:survey_booked → sold`) is the trigger event.

**Stage E — Deal value capture.** On the `→ sold` transition they read `deal.value` (datapoint #4; log shows `£17,124`) and compute `time_to_close` (`4 days 3 hrs 12 mins`). This is the money signal that makes value-based optimization possible.

**Stage F — The join (uid ↔ fbclid ↔ ad).** Using the `uid` they look up the stored session record and recover `fb_click_id` and `ad_id`; the log literally shows "fb_click_id + ad_id matched to a named ad." This reunites the closed deal with the specific creative that started it — the thing last-click funnel tracking loses.

**Stage G — CAPI dispatch.** They reconstruct `fbc` from the stored `fbclid` and original click timestamp, and POST a server event (`capi.event lead_sold`, `value:£17,124`) to Meta; log shows `capi.response 200 success` / `meta.signal confirmed`. Meta's optimizer now knows *which ad produced revenue*, and value-based optimization can bias delivery toward high-AOV outcomes.

**Stage H — Cross-session first-touch stitching (their headline claim).** Their essay ("why attribution massively under-reports Meta") documents the Kimble case: £180k tracked through the funnel vs a further £221k where customers *cited* social as the reason — i.e. they only captured ~45% of true influence. Their fix for the *trackable* slice: an ad click that does NOT convert, followed later by an organic/direct visit + form fill, is stitched back to the **first touchpoint** via `ipAddress` + `funnelStartPage` + returning-`uid` cookie. That is first-touch attribution across sessions. (Note: the essay is qualitative — it does not claim to solve the untracked £221k, only to name it.)

**Stage I — Airtable backend + public data feed.** UTM/lead/asset data also flows into an "extensive Airtable system" for cross-client analysis (CPL, asset performance, concept effectiveness). Opted-in `sold`/`quoted` rows fan out to the public **/data-feed** and **/leaderboard** (all-time 8,695 sales, £102,234,903 revenue, £11,758 AOV, per-lead rows anonymized as "Mutant#XXXX", real-time "sold a £13,302 system" toasts, "under-reported while in beta"). The feed is a growth loop: the attribution ledger *is* the marketing asset.

---

### 2. The Meta features/APIs a rebuild MUST use — and their gotchas

**Conversions API (CAPI) is the whole game.** Offline Conversions API was **permanently discontinued in May 2025** — all CRM/offline events now flow through standard CAPI with `action_source` set appropriately (`system_generated`/CRM). Without CAPI in 2026 you lose an estimated 40–60% of conversion visibility.

- **Event naming / CRM stage mapping.** Use standard `Lead` for the initial submission and map downstream CRM stages to events Meta can optimize toward. Meta's **Conversion Leads / CAPI-for-CRM** integration wants you to send lead-stage updates (new → qualified → survey_booked → sold) so the optimizer learns which leads become revenue. Store the **15–17 digit Meta Lead ID** when the lead first arrives — it is the most reliable CRM identifier; if absent, fall back to click ID / hashed phone / email.
- **Deduplication.** If you ALSO fire a browser Pixel event (recommended — run Pixel + CAPI in parallel), you MUST share a stable `event_id` + matching `event_name` between the two. Dedup keys on `event_name`+`event_id` ONLY — user identifiers (fbp/fbc/em/ph) help *matching*, not dedup. SOS's server-only `lead_sold` has no browser twin, so dedup mainly matters for the top-of-funnel `Lead`/`PageView` events.
- **fbc reconstruction (the load-bearing trick).** `fbc` format is `fb.1.<13-digit-unix-ms-timestamp>.<fbclid>`. For a sale closed days/weeks later you rebuild it from the **stored fbclid + original click timestamp** — which is why fbclid must be persisted server-side at click time, not left in browser memory. **Never fabricate fbc when there was no real Meta click** (no fbclid → no fbc). `fbc`/`fbp` are sent as **plain strings** in `user_data`, never hashed; email/phone ARE SHA-256 hashed.
- **Event Match Quality (EMQ).** Meta scores 1–10 on how many user params you send and how well they match. More params (hashed em, ph, fn, ln, zip, `client_ip_address`, `client_user_agent`, plus fbc/fbp) = higher EMQ = better attribution. SOS's 29-day-PII window (below) is in tension with EMQ for *late* sales — reconstructing hashed em/ph after PII deletion is impossible, so match quality on long-close deals degrades to fbc-only.
- **Attribution & upload windows.** You have **90 days** from impression to upload an offline/CRM event, but Meta's confidence drops sharply after ~48h — upload stage changes fast. Meta **removed 7-day and 28-day view-through windows from Ads Manager/Insights API on 12 Jan 2026**; shift optimization/reporting to **7-day-click (or 1-day-click)**. For lead gen, align reporting to funnel velocity (e.g. a 7-day delay) — but solar closes in *weeks*, which is the structural mismatch: the sale often lands outside the click window the optimizer trusts, so the value signal is late and partially unattributed. This is precisely why SOS also keeps its OWN ledger rather than trusting Ads Manager.
- **Aggregated Event Measurement (AEM) / iOS signal loss.** Post-ATT, iOS opt-out users are measured through AEM. Good news for a rebuild: Meta **removed the 8-event cap and event prioritization** — all eligible standard + custom events are processed, and with Value Optimization enabled AEM now sums the value of all eligible events **even for opted-out iOS users**, no ranking needed. Value-based bidding + CAPI is the recommended iOS-era recovery path.
- **Value-based optimization, value rules, lookalikes.** Send `value` + `currency` on the sold event to unlock value optimization (bias delivery toward high-AOV customers) and **value-based lookalikes / LTV-modeled audiences** seeded from your CAPI `lead_sold` events. Value rules let you tell Meta certain segments are worth more. **Minimum volumes:** target ≥50 leads/week (Meta's CRM doc says ≥200 leads/month + upload ≥1×/day), optimize for a stage with a **1–40% conversion rate** occurring **within 28 days** of lead creation. Solar's low close-rate + long cycle sits at the edge of these thresholds — another reason SOS optimizes on their *own* cost-per-quote/sale math rather than leaning solely on Meta's optimizer.

---

### 3. The GDPR 29-day / UID design (technically)

The public claim (verbatim): *"We do all tracking via UIDs rather than personally identifiable information"* and *"we do not store names, emails or phone numbers (or any PII) beyond 29 days."* Technically this is a **two-table split**:

- A **durable analytics table** keyed by the opaque `uid`/`sosId`, holding only non-PII: `fbclid`, `ad_id`, UTMs, `pipelineStage`, `dealValue`, `sold`/`quoted`, `time_to_close`, timestamps, `clientId`, `funnelStartPage`. This lives forever and powers the leaderboard/Airtable analytics — none of it identifies a person, so retention is unbounded.
- A **short-lived PII table** (name/email/phone/postcode/ipAddress) linked by `uid`, on a **29-day TTL** (a hard delete job; 29 not 30 is a deliberate margin under the "one month" GDPR data-minimization framing). `ipAddress` and `postcode` are quasi-identifiers, hence their inclusion in the purge.

The consequence: attribution and revenue tracking survive PII deletion because the money signal is joined by `uid`, not by email. The cost, as noted, is that CAPI EMQ for a sale closing after day 29 can only send `fbc`/`fbp` (no fresh hashed em/ph). The "clients control publication granularity" (full / redacted / hidden) is a per-`clientId` flag gating what the public feed renders — the same non-PII row, three visibility levels.

---

### 4. What the four datapoints imply for the data model

The four datapoints map cleanly to a normalized schema a rebuild should adopt:

1. **Initial submission info** → a `leads` table: `sosId` (PK), `perspectiveId`, `crmId`, `clientId`, funnel answers (`appeal`, `product`), `funnelStartPage`, `dateCreated`, and the FK to the PII table.
2. **Session tracking** → a `sessions`/`touchpoints` table keyed by `uid`: `fbclid`, `ad_id`, full UTM set, `ipAddress`, `funnelStartPage`, click timestamp (needed for fbc). One lead can have MANY sessions (this is the table that enables cross-session stitching — and where multi-touch would live).
3. **Pipeline stage/status** → a `stage_events` append-only log: `(sosId, from_stage, to_stage, occurred_at)`. Append-only is what makes both the webhook and the poll idempotent and lets you replay/audit; the terminal `→ sold` row is the CAPI trigger.
4. **Deal value** → `dealValue` + derived `time_to_close`, `quoted`/`sold` booleans on the lead, plus a `capi_dispatches` table recording `(event_id, event_name, value, sent_at, meta_response)` for idempotency (never double-fire `lead_sold`).

The presence of **three external IDs** (`perspectiveId`, `crmId`, `sosId`) is the single most important modeling lesson: own a **canonical internal key** and treat every external system's ID as a mapped alias, so you can survive a CRM swap or a funnel-tool swap without losing history. This is directly analogous to identity-resolution in a lifecycle engine (canonical contact key + alias merge).

---

### 5. Where multi-model attribution slots in — and what a superior system does

**What SOS actually does today:** first-touch *stitching* (recover the earliest ad click for a converter across sessions) + **last-click-style CAPI feedback** (fire one `lead_sold` against the matched `ad_id`). That is effectively **single-touch on both ends** — first-touch for their internal narrative/leaderboard, last-touch (the one matched ad) for the Meta signal. There is no linear/time-decay/position-based/data-driven allocation of credit across the *middle* of the journey. Their own Kimble essay concedes the model captures ~45% of influence and names the gap but does not model it.

**Why that is a real limitation for solar:** solar journeys are long and multi-exposure (educational video ads nurture for weeks before a direct-search conversion). Crediting 100% to first OR last touch systematically mis-prices mid-funnel creative and view-through — exactly the £221k "influenced but untracked" bucket.

**Where multi-model slots in (rebuild design):** the `sessions`/`touchpoints` table (datapoint #2) is the natural home. Every touch — paid click, organic visit, email open, retargeting impression — is a row keyed to the resolved `sosId`. On a `→ sold` event you run a **pluggable attribution engine** over that ordered touch list to allocate the `dealValue`:
- **first-touch / last-click** (what they have) — trivial baselines.
- **linear** — equal split across touches (good for "everything mattered" reporting).
- **time-decay** — exponential half-life weighting toward the close; well-suited to solar's long nurture where recency correlates with intent.
- **position-based (U-shaped 40/20/40)** and **W-shaped** (adds weight to the mid-funnel lead-creation touch) — arguably the best rule-based fit for a funnel business, since it explicitly credits both the discovery ad AND the quiz-completion moment.
- **data-driven / probabilistic** — **Markov chain** (removal-effect on transition matrices) or **Shapley value** (game-theoretic marginal contribution) for a defensible, non-arbitrary allocation once volume is sufficient (8,695 sales is plenty to train on).
- **blended** — report several models side-by-side so the operator sees the range, not a single false-precision number.

**Critical rebuild subtlety — reporting model ≠ optimization signal.** You can run rich multi-model attribution *internally* for the client dashboard and pricing decisions, but **Meta's CAPI still wants a single conversion event with a single value per ad**. So a superior system decouples two layers: (a) an **internal multi-model ledger** that fractionally credits every touch/creative for reporting and budget allocation, and (b) a **Meta feedback layer** that still fires one `lead_sold` with full value against the best-matched click (last-click for the optimizer's benefit), OR — more sophisticated — sends **value-weighted events per touch** using the model's fractional credit so Meta's value optimizer sees a richer picture. Add **incrementality/geo-holdout testing** on top to validate the models against reality (the only true answer to "did the ad cause the sale"). That combination — multi-model internal ledger + value-based CAPI + incrementality validation — is what beats SOS's single-touch-both-ends design while keeping their operational discipline (own ledger, UID privacy, webhook+poll stage sync, public revenue feed as a growth loop).

**Rebuild build-order recommendation:** (1) session/uid capture + fbclid server-persist on the funnel; (2) lead ledger with canonical `sosId` + external-ID aliases; (3) CRM plugin layer (webhook + poll, per-CRM adapters) emitting a normalized append-only `stage_events` stream; (4) uid↔fbclid↔ad join + CAPI dispatcher with fbc reconstruction, event_id dedup, value/currency, idempotent dispatch log; (5) the two-table 29-day-PII GDPR split; (6) the pluggable multi-model attribution engine over the touch table; (7) the public opted-in data feed as the marketing flywheel. Steps 1–4 replicate SOS; steps 6–7 are where you exceed them.

---

### Sources
- https://solaronsteroids.com/service/data
- https://solaronsteroids.com/resources/why-attribution-massively-underreports-meta-ads-impact
- https://solaronsteroids.com/resources/utm-parameters-explained-for-solar-installers
- https://solaronsteroids.com/resources/why-cost-per-lead-is-a-misleading-metric-in-solar
- https://solaronsteroids.com/case-studies/current-renewables-early-traction-with-full-visibility
- https://solaronsteroids.com/resources/how-to-score-commercial-solar-leads-(properly)
- https://solaronsteroids.com/data-feed
- https://developers.facebook.com/docs/marketing-api/conversions-api/
- https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration
- https://developers.facebook.com/docs/marketing-api/conversions-api/guides/conversions-api-crm-for-platforms/
- https://leadsbridge.com/blog/conversion-leads-optimization-facebook/
- https://www.conversios.io/blog/meta-aggregated-event-measurement/
- https://www.dojoai.com/blog/meta-ads-attribution-2026-changes-fixes
- https://watsspace.com/blog/meta-conversions-api-fbc-and-fbp-parameters/
- https://conversiontracking.io/blog/meta-facebook-offline-conversion-tracking-guide/
- https://www.fiegenbaum.solutions/en/blog/optimizing-metas-conversion-api-enhancing-event-match-quality-and-deduplication
- https://help.gohighlevel.com/support/solutions/articles/48001233833-facebook-conversion-leads-walkthrough
- https://www.perspective.co/integrations
- https://www.factors.ai/blog/types-of-attribution-models

## Key facts

- [VERIFIED] SOS optimizes Meta spend on cost-per-quote/cost-per-sale, not cost-per-lead, via four datapoints: initial submission info, session tracking, pipeline stage/status, deal value (/service/data).
- [VERIFIED] System log shows BOTH POST /webhooks/crm and crm.poll (delay:2341ms) — they use webhook + polling per CRM for stage-change detection (belt-and-braces).
- [VERIFIED] The join is uid → stored fbclid + ad_id, 'matched to a named ad', then capi.event lead_sold with value £17,124 dispatched to Meta, capi.response 200 (/service/data).
- [VERIFIED] Tracked fields (verbatim) include three external IDs: perspectiveId, crmId, sosId — a canonical internal key plus per-system aliases.
- [VERIFIED] GDPR design: all tracking via opaque UIDs; no names/emails/phones/PII stored beyond 29 days; clients control publication granularity (full/redacted/hidden).
- [VERIFIED] Kimble case: £180k tracked through funnel vs £221k additional influenced revenue — SOS captures only ~45% of true campaign influence; gap named but not modeled.
- [VERIFIED] SOS uses long UTM tracking URLs (utm_source/medium/campaign/content), deliberately disables funnel autofill to preserve lead qualification.
- [VERIFIED] UTM/lead data also flows into an 'extensive Airtable system' for cross-client CPL/asset/concept analysis, and to the public /data-feed leaderboard.
- [VERIFIED] Cost-per-lead essay: CPA = CPL × (1/close rate); £100 CPL @50% close = £200 CPA beats £2 CPL @0.1% close = £2,000 CPA; cheap leads signal poor quality.
- [VERIFIED] Meta permanently discontinued the Offline Conversions API in May 2025 — all CRM/offline events now flow through standard Conversions API.
- [VERIFIED] Meta Conversion Leads/CRM: store the 15–17 digit Meta Lead ID; optimize a stage with 1–40% conversion rate occurring within 28 days; ≥200 leads/month, upload ≥1×/day.
- [VERIFIED] fbc format = fb.1.<13-digit-unix-ms-timestamp>.<fbclid>; reconstructed from stored fbclid + original click timestamp for late CRM sales; fbc/fbp sent as plain strings (not hashed).
- [VERIFIED] Never fabricate fbc when no real Meta click (no fbclid) exists; email/phone ARE SHA-256 hashed, fbc/fbp are not.
- [VERIFIED] CAPI dedup keys on event_name + event_id ONLY; user identifiers (fbp/fbc/em/ph) aid matching not dedup; run Pixel + CAPI in parallel with shared event_id.
- [VERIFIED] Event Match Quality (EMQ) is scored 1–10 by number/quality of user params sent; more params = higher EMQ = better attribution.
- [VERIFIED] Meta removed 7-day and 28-day view-through attribution windows from Ads Manager/Insights API on 12 Jan 2026; shift to 7-day-click (or 1-day-click).
- [VERIFIED] AEM removed the 8-event cap and prioritization; with Value Optimization it now sums value of all eligible events even for opted-out iOS users.
- [VERIFIED] Offline/CRM events: 90-day upload window from impression, but Meta confidence drops sharply after ~48h — upload stage changes fast.
- [VERIFIED] Perspective natively passes UTMs, supports Facebook Pixel, hidden fields, and webhooks/Zapier/Make into HubSpot/Salesforce/GoHighLevel.
- [INFERRED] SOS's attribution today = first-touch cross-session stitching (via ipAddress/funnelStartPage/uid) + last-click-style single CAPI event — NOT true multi-model attribution.
- [INFERRED] GDPR design is a two-table split: durable non-PII analytics table keyed by uid (unbounded retention) + short-lived PII table on a 29-day hard-delete TTL.
- [INFERRED] Late-closing solar deals degrade CAPI EMQ: after day-29 PII purge only fbc/fbp can be sent (no fresh hashed em/ph), and the sale often falls outside Meta's trusted click window.
- [INFERRED] A superior rebuild decouples an internal multi-model fractional-credit ledger (reporting/budgeting) from the Meta feedback layer (single value-based lead_sold), validated by incrementality/geo-holdout tests.
- [INFERRED] The sessions/touchpoints table (datapoint #2) is where linear/time-decay/position-based(U/W)/Markov/Shapley attribution slots in; 8,695 sales is enough volume to train data-driven models.

## Open questions

- Does SOS actually persist fbclid server-side at click time, or reconstruct fbc from a browser cookie? The /service/data log implies server-side but does not confirm the exact storage layer.
- How do they handle CAPI idempotency across the webhook AND poll paths — what dedup key prevents a stage change detected by both from firing lead_sold twice?
- What exact event_name(s) do they send to Meta (standard 'Lead' + custom 'lead_sold'/'lead_quoted', or Purchase)? The log shows 'lead_sold' which is a custom event, not a standard one.
- How do they reconcile solar's multi-week close cycle with Meta's 28-day optimization window and post-Jan-2026 7-day-click default — do late sales simply not feed the optimizer?
- What is the real per-CRM adapter surface (auth, stage-field mapping, poll cadence) for the six named CRMs, and how much is bespoke per client?
- Is the 'bespoke attribution system' a single multi-tenant platform (clientId-scoped) or per-client deployments — and how does that affect the £40k–£100k licensing packaging?
- How is the public data feed reconciled against real CRM data (the 'under-reported while in beta' note) — is it near-real-time from the same ledger or a delayed export?
- Do they send value-weighted per-touch events to Meta or only one full-value last-click event? Their materials suggest single-event, but this is not confirmed.
- What is Perspective's exact webhook payload shape and whether the uid/fbclid are injected as hidden fields client-side or appended server-side at redirect.
