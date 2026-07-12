# Research: market-productization

## Productization Landscape: Revenue-First Attribution + Pluggable CRM Sync

### Framing

Solar on Steroids (SOS) has, as a services business, hand-built the exact product a from-scratch software company would want to sell: a revenue-first attribution engine that optimises Meta ad spend on **cost-per-quote and cost-per-sale** (not cost-per-lead), by stitching a click ID → a session UID → a CRM deal → a deal value, then firing a valued `lead_sold` event back to Meta via CAPI. They then wrap it in a **client-facing live revenue proof feed** (`/data-feed`, `/leaderboard`, real-time "sold a £13,302 system" toasts) and sell the underlying system to *other* agencies for £40k–£100k. The question is who competes with each layer and where the whitespace sits.

The short answer: **every layer exists somewhere in the market, but no single product ships all of them together, and the two pieces that are SOS's actual moat — (a) arbitrary CRM-pipeline-stage → valued CAPI conversion across many CRMs via poll *and* webhook, and (b) a shareable public revenue-proof feed as a sales asset — are the least commoditised.**

### 1. Market map

| Product | Attribution models | CRM-stage → ad-platform loop (CAPI/valued) | Value / revenue depth | Target customer | Pricing (2025-26) |
|---|---|---|---|---|---|
| **Hyros** | First, last, linear, U-shaped, "lead-conversion touch" (heuristic, not data-driven) | Yes — call-funnel oriented; matches click ID → email → every downstream event; sends CAPI. Built for high-ticket call funnels | Deep on sales value; ties clicks to phone-call closes | High-ticket coaches, info, call-based funnels | Revenue-tiered ~$230/mo ($20k rev) → $1,499/mo ($750k rev), custom >$1M; Shopify track from $69/mo. Sales-demo gated |
| **Triple Whale (Sonar)** | First-click, last-click, linear, "Triple Attribution" (heuristic) | Yes — Sonar Optimize enriches Triple Pixel events + passes back to Meta CAPI server-side w/ dedup key | Deep, but **DTC/Shopify GMV** framing, not pipeline-stage | Ecommerce/DTC brands | GMV-tiered; ~$1,129/mo ($5-7M GMV) → $1,849/mo ($10-15M). Sonar bundled in new paid tiers |
| **Cometly** | Multi-touch across CRM stages; per-channel/campaign/ad/landing-page/stage/cohort | **Yes — closest to SOS.** Maps ad spend to HubSpot/Salesforce lifecycle stages (MQL→SQL→demo→opp→closed-won) at ad level; CAPI to Meta/Google/LinkedIn/TikTok, ~9.3/10 match | Unifies ad spend + sessions + CRM pipeline + Stripe revenue | B2B SaaS | Session-tiered; $750/mo (50k sessions) → Enterprise $1,495/mo. No free trial, onboarding required |
| **Wicked Reports** | First, last, linear, "Full Impact" / "Full Funnel" | Partial — tracks clicks against CRM + order system; can push cost caps, less about live CAPI stage-sync | **Strong on lead value + LTV** (New Lead Cohort → actual LTV); explicitly attributes *lead* value not just purchase | Lead-gen, subscription, info marketers | Contact-tiered; $500/mo (50k contacts, "Wicked Good") → $800/mo ("Wicked Awesome") |
| **AnyTrack** | Click-based, multi-source | Yes — feeds enriched lead conversions to Meta CAPI, Google Enhanced Conversions, LinkedIn; **has a native GoHighLevel + Meta-CAPI-for-CRM recipe** | Lead-quality focused (CPL); form + call + CRM events | Lead-gen, affiliate, performance | $50 / $150 / $300 per mo + free tier; bespoke integration builds $2k-$15k |
| **SegMetrics** | First-click, first-engagement, last-touch, full-funnel | Partial — unifies ad + site + ESP + CRM + payment; reporting-first, less live CAPI push | Real LTV visibility, click-to-revenue verification | Coaches, creators, course sellers | Active-contact based, from ~$27/mo; 14-day trial |
| **WhatConverts** | Multi-touch, full customer journey | Weak on CAPI push; strong on capture. Imports leads to CRM | Per-lead **quotable / quote value / sale value** marking — mirrors SOS's Quoted/Sold; **white-label** for agencies | Agencies, local/home services | $30 (call) → Plus $60/user → Pro $100 → Elite $160 → **Agency $500/mo** (unlimited accounts) |
| **CallRail** | Multi-touch, milestone credit distribution, cost-per-lead | Weak (reporting, call-centric) | Cost-per-lead + revenue matching, call-focused | Local services, agencies | $50/mo → $195/mo + usage |
| **Attributer** | Channel/campaign/source lead-source (first-touch bias) | No CAPI loop; writes source fields into CRM/forms | Lead-source → CRM field enrichment, thin on value | SMB/B2B ops teams | Setup $300-$2k, integrations $100-$1k/mo, dashboards $250-$2.5k/yr |
| **Dub.co** | Multi-stage click→lead→sale, 90-day cookie | Partial — dev-first `POST /track/sale`, native payment-processor conversions; not CRM-pipeline-stage oriented | Click→signup→sale, CAC/LTV; **API/SDK-first, TS-native** | Developers, SaaS, creator/affiliate programs | Freemium SaaS; usage/seat tiers |
| **GoHighLevel** | Native attribution report + UTM; conversion-leads workflow | **Yes but walled-garden** — Meta CAPI workflow trigger + Conversion Leads event fires on *its own* CRM stage/opportunity changes only | Purchase events w/ value + hashed PII, actual order IDs | Agencies (white-label CRM resale) | Agency SaaS $97-$497/mo + white-label |
| **CustomerLabs / Stape** | Linear, time-decay, position/U/W, custom; BigQuery data-driven | **Infra for the loop** — server-side + CRM/offline → CAPI; you assemble the logic | Signal engineering, identity resolution, offline conversions | Data/growth engineers, agencies | CustomerLabs from $99/mo; Stape sGTM $17-$50/mo + CAPI gateway $10-$100/mo |
| **Boberdoo / ActiveProspect (LeadConduit)** | n/a (distribution, not attribution) | n/a — ping/post lead routing, buy-side compliance | Lead billing/routing/value, not ad-loop | Lead brokers, aggregators | Custom; boberdoo setup $500-$2k, "high at scale" |

### 2. The gap a from-scratch build would fill

Score the five capabilities SOS bundles against who actually has each:

1. **Multi-model attribution engine (first / last / linear / time-decay / position / blended, side-by-side switchable).** *Partially covered, but fragmented and heuristic.* Hyros (first/last/linear/U), Triple Whale (first/last/linear/Triple), SegMetrics (4 models), CustomerLabs (linear/time-decay/U/W/custom + BigQuery data-driven). **No lead-gen-focused product exposes all six as first-class, switchable, per-campaign lenses.** Genuine *data-driven/algorithmic* attribution remains GA4/Adobe territory; and note SOS itself is really **first-touch-across-sessions** dressed up. So "true multi-model, switchable, in one screen, for lead-gen with CRM value" is genuinely open.

2. **Conversion-point definitions per campaign/journey (declare which pipeline stage = which valued conversion, per client).** *Weakly covered.* Cometly hard-maps generic B2B lifecycle stages; GHL fires on its own opportunity stages; Meta's own Conversion Leads integration lets you map custom lead stages. But a **config layer where each client/campaign declares "survey_booked → quoted (value=quote), sold → purchase (value=deal)"** across arbitrary CRMs is not a shipped product feature anywhere — it's exactly the custom logic SOS's technical VA hand-wrote. **This is the core product primitive to build.**

3. **Value / revenue tracking depth.** *Best-covered layer.* Wicked Reports (lead value + LTV cohorts), Cometly (Stripe + pipeline), Hyros, WhatConverts (per-lead quote/sale values). Table stakes — but SOS's twist is tracking value at *both* quote and sale stages and computing `time_to_close`, which most tools flatten to a single purchase value.

4. **CRM plugin system (many CRMs, poll *and* webhook).** *Structurally missing.* This is the single biggest whitespace. AnyTrack has a GHL recipe; Cometly does HubSpot/Salesforce; GHL only does itself. **Nobody offers a broad plugin marketplace (Attio, HubSpot, GHL, Salesforce, Monday, Pipedrive, Payaca, "bespoke if API available") that normalises pipeline-stage changes via BOTH webhook subscription AND scheduled polling** (SOS's log literally shows `crm.poll` *and* `POST /webhooks/crm` — polling is the fallback for CRMs with weak/absent webhooks, which is most of the long-tail home-services CRMs). A pluggable, poll-or-webhook CRM sync layer is where a TypeScript infra builder has a durable, defensible edge — and maps cleanly onto the `defineWebhookSource → ingestEvent` primitive you already run.

5. **Client-facing live revenue proof feed.** *Almost entirely uncovered.* Attribution dashboards are inward-facing. **No competitor ships a public, embeddable, shareable revenue-proof feed / leaderboard / real-time "sold a £X system" toast stream as a marketing + sales asset.** This is SOS's most-copied-worthy, least-copied idea: it turns your attribution data into top-of-funnel social proof and a retention/upsell hook. For an agency-enablement product it's a killer differentiator (every client site becomes a billboard).

**The from-scratch wedge, precisely stated:** a TypeScript-native platform whose atomic unit is a *conversion-point definition* (`{ campaignId, crmStage, event, valueField }`), fed by a **pluggable multi-CRM sync layer (webhook + poll)** that resolves click_id→uid→deal, runs a **switchable multi-model attribution engine** over the resulting touch graph, dispatches **valued CAPI events** on stage change, and exposes a **public embeddable proof feed** as a first-class output. Cometly is the nearest competitor but is locked to B2B-SaaS lifecycle stages + Stripe and has no proof feed; GHL has the loop but only inside its own walled CRM; the infra players (Stape/CustomerLabs) give you the pipes but no product opinion.

### 3. Pricing benchmarks & business-model options

**Attribution-SaaS benchmark ranges (metered on the value you attribute):**
- Entry lead-gen/creator tools: **$27–$300/mo** (SegMetrics, AnyTrack, WhatConverts base, CallRail).
- Mid-market revenue-attribution: **$500–$1,500/mo**, metered by contacts (Wicked $500-800), sessions (Cometly $750-1,495), or tracked revenue (Hyros $230→$1,499), or GMV (Triple Whale $1,129-1,849).
- Infra/usage: **$10–$100/mo** per-pixel/per-request (Stape), $99/mo (CustomerLabs).
- Integration/setup fees are normal and expected: **$300–$15k** one-off (Attributer, AnyTrack bespoke, boberdoo).

**Three business-model shapes:**

- **(A) Pure SaaS** — meter on tracked revenue or sessions, $500-$1,500/mo mid-market. Highest multiple, hardest go-to-market (attribution requires CRM + ad-account setup; nobody offers a free trial for a reason — Cometly and Hyros both gate on demos). Onboarding services attach naturally ($1-5k setup).
- **(B) Agency / done-for-you** — SOS's core model: ad management retainer (min £2,500/mo ad spend) + setup fee + performance bets. Highest revenue per client, non-recurring-software risk, doesn't scale as software.
- **(C) Agency-enablement license (the SOS £40k-£100k play)** — sell the *system* to other agencies as their IP. This is the most interesting and least contested. The white-label precedent is GoHighLevel (agencies resell a branded CRM), and WhatConverts white-labels attribution — but **nobody licenses a revenue-first attribution + CAPI + proof-feed engine as an installable agency asset.** A productized version could be: a $10k-$40k license + $X/mo platform fee per agency, each agency reselling to its own installer/contractor clients. This is effectively "Shopify for lead-gen agencies" and is where SOS's own "competitors literally cannot compete with our IP" claim signals a real, defensible category. A from-scratch build could undercut the £40-100k bespoke price with a repeatable licensed platform.

Recommendation for a builder with lifecycle-infra DNA: **lead with (C) agency-enablement, priced between white-label GHL and SOS's bespoke fee (e.g. $15k setup + $500-1,500/mo per agency), and offer (A) self-serve SaaS as the down-market on-ramp.** The vertical wedge is home services beyond solar — SOS already runs `/call/uk-windows`, and the same model (Perspective/quiz funnel → CRM → valued CAPI) applies identically to windows, HVAC, roofing, remodeling, where WebFX/SearchLight data shows attribution is "underused" and CRM+ad-loop is the acknowledged pain point.

### 4. Why incumbents haven't closed the CRM-stage→CAPI loop well (and who has)

The loop is genuinely hard for structural reasons, not neglect:

- **It's N×M integration work.** Every CRM has a different stage model, webhook reliability, and API. Meta's own Conversion Leads / CRM integration is a *separate* CAPI setup from web CAPI, with different required parameters, and demands you map custom lead stages to events — fiddly enough that most tools punt. Polling as a fallback (which SOS does) is unglamorous plumbing nobody wants to own generically.
- **Identity stitching is the crux.** You must carry `fb_click_id`/`ad_id` from an anonymous ad click, through a form UID, into a CRM record that may be created days later, to a deal value at close — across sessions and devices. SOS solved this with UID-based session tracking and first-touch stitching (ad click with no form fill → later organic visit + form fill → joined). Most attribution tools only reliably stitch inside a single identity domain (Shopify checkout, Stripe customer, their own pixel), which is why Triple Whale is strong in DTC and Cometly in B2B-SaaS-with-Stripe but neither generalises to "any installer's random CRM."
- **Long sales cycles break browser-window attribution.** Solar/home-services close in weeks-to-months, past Meta's click windows — so the *only* correct mechanism is offline/CRM-triggered CAPI upload, which is precisely the muscle none of the DTC-first tools built.

**Who has actually closed it:**
- **GoHighLevel** closed it *cleanly but only inside its own walled garden* — its workflow "Conversions API" trigger fires on GHL opportunity/stage changes with value + hashed PII + real order IDs. Great if the client lives entirely in GHL; useless for the multi-CRM reality.
- **Cometly** is the closest *general* product — real ad-level mapping of CRM lifecycle stages to server-side CAPI across Meta/Google/LinkedIn/TikTok — but it's opinionated toward B2B SaaS (MQL/SQL/opp/closed-won + Stripe) and has no client-facing proof feed or agency-license motion.
- **Stape / CustomerLabs** provide the *infrastructure* to do it (server-side + offline/CRM → CAPI, identity resolution) but hand you pipes, not a conversion-point product.
- **Hyros** nails it for *call-based high-ticket funnels* (click → email → phone close) but is not CRM-pipeline-stage-generic and is expensive.

**Conclusion:** the loop is closed either narrowly (GHL, inside its own CRM) or verticalised (Hyros calls, Cometly B2B SaaS, Triple Whale DTC). The **generic, multi-CRM, poll-or-webhook, arbitrary-stage-to-valued-CAPI loop with a switchable multi-model engine and a public proof feed** — exactly what SOS hand-built as a service and sells for £40-100k — has **not** been productized. That is the build.

### Sources

- https://hyros.com/pricing-ai-tracking · https://checkthat.ai/brands/hyros/pricing · https://hyros.com/updates/attribution-modeling-types-benefits-more/
- https://www.triplewhale.com/pricing · https://www.triplewhale.com/sonar · https://kb.triplewhale.com/en/articles/11021684-quick-start-guide-triple-whale-meta-attribution-passback-integration
- https://www.cometly.com/pricing · https://www.cometly.com/marketing-attribution-software · https://www.cometly.com/platform/conversion-api
- https://www.wickedreports.com/wicked-pricing · https://www.wickedreports.com/attribution-modeling-for-lead-gen-subscription-and-customer-lifetime-value
- https://anytrack.io/pricing · https://anytrack.io/connect-metacapicrm-and-gohighlevel · https://anytrack.io/solutions/lead-generation
- https://segmetrics.io/pricing/ · https://segmetrics.io/feature/attribution-models/
- https://www.whatconverts.com/pricing/ · https://www.whatconverts.com/features/lead-tracking/call-tracking/white-label-call-tracking/
- https://www.callrail.com/call-tracking/attribution · https://softwarefinder.com/marketing-software/attributer
- https://dub.co/docs/concepts/attribution · https://dub.co/blog/introducing-dub-conversions
- https://help.gohighlevel.com/support/solutions/articles/48001233833-facebook-conversion-leads-walkthrough · https://ideas.gohighlevel.com/changelog/enhanced-meta-pixel-tracking-for-funnel-and-website-builder · https://www.gohighlevel.com/white-label-crm
- https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration · https://www.customerlabs.com/first-party-data-ops/offline-conversions/
- https://www.customerlabs.com/pricing/ · https://stape.io/price
- https://www.boberdoo.com/ping-post-ping-tree · https://activeprospect.com/blog/boberdoo-alternative/
- https://www.perspective.co/article/quiz-funnel-software · https://www.webfx.com/blog/home-services/home-services-marketing-benchmarks/ · https://searchlightdigital.io/marketing-attribution/

## Key facts

- [VERIFIED] Hyros is revenue-tiered: ~$230/mo ($20k tracked rev) to $1,499/mo ($750k), custom >$1M, Shopify track from $69/mo; supports first/last/linear/U-shaped, built for high-ticket call funnels (click ID -> email -> phone close)
- [VERIFIED] Triple Whale is GMV-tiered (~$1,129/mo at $5-7M GMV, $1,849/mo at $10-15M); Sonar Optimize enriches Triple Pixel events and passes back to Meta CAPI server-side with a dedup key; models are first/last/linear/Triple
- [VERIFIED] Cometly is the nearest full competitor: maps ad spend to HubSpot/Salesforce lifecycle stages (MQL->SQL->demo->opp->closed-won) at ad level, CAPI to Meta/Google/LinkedIn/TikTok at ~9.3/10 match; session-tiered $750-$1,495/mo, no free trial
- [VERIFIED] Wicked Reports uniquely attributes LEAD value + LTV (New Lead Cohort -> actual LTV), not just purchase value; contact-tiered $500-$800/mo; models first/last/linear/Full Impact
- [VERIFIED] AnyTrack feeds enriched CRM lead conversions to Meta CAPI + Google Enhanced Conversions + LinkedIn, has a native GoHighLevel+Meta-CAPI-for-CRM recipe; $50/$150/$300 per mo + bespoke integration builds $2k-$15k
- [VERIFIED] WhatConverts marks each lead quotable/quote-value/sale-value (mirrors SOS Quoted/Sold), offers full white-label; Agency plan $500/mo unlimited accounts
- [VERIFIED] GoHighLevel closes the CRM-stage->CAPI loop cleanly but only inside its own walled-garden CRM: workflow Conversions API trigger fires on GHL opportunity/stage changes with value + hashed PII + real order IDs
- [VERIFIED] Meta's Conversion Leads / CRM CAPI integration is a SEPARATE setup from web CAPI with different required parameters; you map custom lead stages to events and use the Conversion Leads performance goal to optimise for leads that actually convert
- [VERIFIED] SegMetrics offers first-click/first-engagement/last-touch/full-funnel across ad+site+ESP+CRM+payment, contact-based from ~$27/mo with 14-day trial (coaches/creators focus)
- [VERIFIED] CustomerLabs (from $99/mo) + Stape ($17-$50/mo sGTM + $10-$100/mo CAPI gateway) are the infrastructure layer for CRM/offline->CAPI; CustomerLabs supports linear/time-decay/U/W/custom + BigQuery data-driven
- [VERIFIED] Dub.co is TS/dev-first link attribution with multi-stage click->lead->sale, 90-day cookie, native payment-processor conversions and POST /track/sale API; not CRM-pipeline-stage oriented
- [VERIFIED] CallRail ($50-$195/mo) and Attributer (setup $300-$2k + $100-$1k/mo integrations) cover call/form lead-source attribution but do not push valued CAPI on CRM stage changes
- [VERIFIED] Boberdoo/ActiveProspect LeadConduit are lead-distribution (ping/post) platforms, not attribution; boberdoo setup $500-$2k, custom-quote pricing
- [INFERRED] Genuine data-driven/algorithmic attribution is rare in this lead-gen segment (GA4/Adobe territory); most tools including SOS use heuristic click-based models (SOS is effectively first-touch-across-sessions)
- [INFERRED] The single biggest whitespace is a broad CRM plugin system that normalises pipeline-stage changes via BOTH webhook AND scheduled polling (SOS's log shows crm.poll and POST /webhooks/crm) across Attio/HubSpot/GHL/Salesforce/Monday/Pipedrive/Payaca
- [INFERRED] A public, embeddable, shareable revenue-proof feed / leaderboard / real-time sold-toast stream as a marketing+sales asset is offered by essentially no attribution competitor; SOS's /data-feed is a near-unique idea
- [INFERRED] The defensible from-scratch primitive is a conversion-point definition {campaignId, crmStage, event, valueField} feeding a switchable multi-model engine + valued CAPI dispatch + public proof feed
- [INFERRED] Agency-enablement licensing (SOS sells its system for £40k-£100k+VAT) is the least-contested business model; white-label GHL and WhatConverts are the only precedents and neither licenses a revenue-first attribution+CAPI+proof-feed engine
- [INFERRED] The loop is hard for structural reasons: N×M CRM integration, cross-session/cross-device identity stitching (click_id->uid->CRM deal->value), and long home-services sales cycles that break Meta's browser click windows (forcing offline/CRM-triggered CAPI upload)
- [INFERRED] The vertical wedge is home services beyond solar (windows/HVAC/roofing/remodeling) where attribution is documented as underused; SOS already runs /call/uk-windows

## Open questions

- Exact list of which CRMs each competitor supports for stage-change -> valued CAPI (vs. import-only), and whether any support polling as a webhook fallback the way SOS does
- Real transaction evidence that anyone has productized/licensed the SOS 'attribution-in-a-box for agencies' play (vs. white-label CRM resale) at the £15k-£100k price point
- Whether Cometly or Hyros can be configured for arbitrary (non-B2B-SaaS, non-call-funnel) pipeline stages per client/campaign, or if the stage model is hard-coded
- Whether any attribution vendor offers a public/embeddable client-facing revenue proof feed as a shipped feature (appears to be none, but unconfirmed)
- Perspective's own attribution/CAPI capabilities and whether it competes with or complements a build (SOS is Perspective's #1 agency partner)
- Actual match-rate and match-quality benchmarks for CRM-stage CAPI events across long sales cycles (weeks-months) vs. Meta's attribution windows
- Whether Dub.co's dev-first API model could be extended by a third party into a CRM-stage attribution layer, making it a build-vs-buy platform option
- Precise agency economics of the SOS model (retainer + ad spend + performance bet) to benchmark a SaaS/enablement price against services revenue per client
