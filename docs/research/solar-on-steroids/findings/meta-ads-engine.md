# Research: meta-ads-engine

## Solar on Steroids — The Paid-Media Engine (Meta Ads Playbook + Attribution Feedback Loop)

### Purpose of this brief
This documents the *paid-media half* of the SOS machine: how they structure Facebook/Meta campaigns, what creative they produce and at what cadence, the doctrine behind their video/testimonial ads, and — the load-bearing part for a rebuild — how quote/sale signals fed back via CAPI reshape bidding and lead quality over time. Where a claim comes straight from an SOS page I mark it VERIFIED; strategic interpretation for a rebuild is INFERRED.

---

### 1. Ad account ownership & the "no emotion in the account" doctrine

The recon brief framed this as "client owns the account." The actual published rationale ([why-i'm-not-allowed-in-our-clients'-ad-accounts](https://solaronsteroids.com/resources/why-i%E2%80%99m-not-allowed-in-our-clients%E2%80%99-ad-accounts)) is subtler and more useful: it is about **who is allowed to touch the account and under what discipline**, not just legal ownership. The founder deliberately excludes *himself* from day-to-day account operation; a designated operator ("Joe") runs it under a defined process. The stated problem: "The problem wasn't intent. It was emotion" — reactive scaling ("Oh my god, that one's getting £8 cost per lead. Put all the budget on that one") is described as "trading with no stop-loss and no exit strategy." The safeguard is procedural: a "disciplined testing and scaling framework" that prevents budget from chasing temporary CPL dips.

The transferable principle for a rebuild: **the account is governed by a rules engine, not a person's gut.** Scaling and kill decisions should be codified (spend-per-creative caps, minimum data thresholds before reallocation, staged budget ramps) so the human running it can't over-react to a single day's numbers. This is the operational complement to the attribution engine — attribution tells you *what's actually working*, the discipline framework stops you from over-fitting to noise before the sale-level signal arrives.

### 2. Campaign structure & the "perform before they optimise" thesis

SOS's core claim is that **great performance is front-loaded into preparation, not squeezed out of Meta's learning phase** ([why-our-meta-ads-campaigns-perform-before-they-even-optimise](https://solaronsteroids.com/resources/why-our-meta-ads-campaigns-perform-before-they-even-optimise)). A single shoot day yields "400 gigabytes to one terabyte of footage" across multiple sites, colour-graded and catalogued into "well over a hundred individual clips." From that library they build "20 to 50 individual ad campaigns" with "five to ten variants of each," deploying "up to 500 creatives." Because the asset bank is deep, a campaign can run "three to six months, or even longer depending on spend, without needing new assets."

The claimed second-order benefit is brand, not just leads: "They're not just going to generate leads; they're going to build brand awareness… brand recognition before the survey. Familiarity during the sales process. And warmer conversations because prospects already feel like they know them." (VERIFIED as their claim.)

The published service process ([/service/facebook-ads](https://solaronsteroids.com/service/facebook-ads)) is a 7-step loop: Discovery → shoot brief → multi-site video shoots (6–7 locations) → editing/branding → daily campaign management → weekly reporting + monthly reviews → recurring content refreshes. Shoots average ~45 minutes per property; they cite 100+ renewables shoots and operation since August 2024.

### 3. Account architecture — volume as anti-fragility

SOS's explicit theory of *why accounts die* ([why-most-meta-ad-accounts-collapse-over-time](https://solaronsteroids.com/resources/why-most-meta-ad-accounts-collapse-over-time)) is **structural fragility from creative concentration**: "When one creative carries too much weight and then drops off, the whole campaign panics overnight." A failing account has 2–5 ads, repetitive price-led formats, no angle testing — "hoping" rather than testing.

Their counter-structure:
- **20+ ads live simultaneously**; 15–20 new creatives produced daily across the client portfolio.
- Real example accounts running **37, 22, and 43 live ads**; only "~8 failures out of 51 total launches."
- Format mix "probably 80% video" plus images; angles span social proof, offers, education, pain-point.
- Philosophy: "consistent mid-level performance outperforms volatile peaks" — build campaigns "robust and sustainable over time" rather than dumping budget on the current winner. (This is the same anti-emotion discipline as §1, expressed at the portfolio level.)

### 4. The four ad types (the creative taxonomy)

From [the-four-ad-types-that-actually-work-for-solar](https://solaronsteroids.com/resources/the-four-ad-types-that-actually-work-for-solar):

1. **Education & Expertise** — the highest-performing, most common category. Install overviews going deep on hardware, cable runs, trench/conduit neatness. Demonstrates craftsmanship.
2. **Engagement** — short, attention-grabbing, humour/skits, built for shareability and personality (not virality).
3. **Offer / Hard CTA** — direct, usually static, "get a quote"/"inquire." Notably: "you don't have to put a price on these for them to work."
4. **Social Proof** — testimonials; weak on cold audiences but "powerfully" effective in retargeting to push prospects through the cycle.

Key stated insight: the strongest campaigns *combine* categories (e.g. education + social proof). For a rebuild, this maps cleanly to a **creative-taxonomy field on every ad asset** so you can measure CPL/cost-per-sale *by ad type and funnel stage*, not just by individual ad.

### 5. The frame-by-frame video formula (Kimble Solar teardown)

From [breaking-down-a-high-performing-solar-ad-frame-by-frame](https://solaronsteroids.com/resources/breaking-down-a-high-performing-solar-ad-frame-by-frame):
- **0–10s authority hook** — lead with a credential, no intro: "Kimble Solar, our Which Renewables installer of the year 2025… today I'm going to take you through one of our installations."
- **Body** — installation walkthrough, narrator VO + b-roll + animations + varied angles ("movement, versatility, variety" to prevent fatigue). Specs stated then translated to layman's terms ("10.5 kW inverter," "10.3 kWh battery"). Story over features (explain *why* the customer chose modular batteries).
- **CTA** — highly specific and benefit-led: "click the button below, enter some details, and we'll give you a call." **Hold-frame after CTA** to stop Meta auto-advancing before the viewer acts.
- Craft details: three-angle shots, cable-route animations, number-plate/app-name blurring, light humour for pacing.
- Claimed result: booked out two surveyors for a month, avg deal value £15,000+, spend *reduced* because lead volume exceeded capacity.

### 6. Video-over-image doctrine & anti-price-shopper hooks

The lead-quality thesis ([why-video-ads-produce-better-leads-than-image-ads](https://solaronsteroids.com/resources/why-video-ads-produce-better-leads-than-image-ads)): "Video ads allow us to educate customers in a way that image ads can't." Image ads attract "budget-focused seekers of the cheapest quotes"; educated video viewers "are therefore more likely to accept premium pricing based on recognized value… rather than 'trying to badger you about how to knock off 200 pounds off the quotes.'" This is the strategic reason the whole machine is video-first: **it filters for margin at the top of the funnel** so the sales team isn't buried in price-shoppers. The "Looking for cheap solar? Go find someone else!" style hook is the explicit copy expression of this filter.

### 7. The trust/reputation layer feeding the ad engine

From [/service/reputation](https://solaronsteroids.com/service/reputation): two testimonial tiers — high-production (polished, but admits it feels "manufactured and pre-arranged") and **low-production self-shot selfie video** ("intentionally low production quality, which is far more believable," zero marginal cost after page setup). Customers submit via a dedicated webpage on their own terms, removing the pressure that makes testimonials feel scripted. Both are then run as FB/IG ads — "turning your customers into your sales team," "a silent army who relentlessly nurture your customers 24/7." Videography backbone ([/service/videography](https://solaronsteroids.com/service/videography)): 500+ systems shot, pro kit (Nikon Z6III, Sony A7SIII/A7IV/A6700, DJI drones/gimbals, Shure SM7B).

The selfie/UGC format is also their **anti-fatigue weapon** (§8): handheld installer walkthroughs with "minimal editing" (subtitles + music + b-roll) that look like organic content, not ads.

### 8. Creative volume, fatigue, and the spend-tiered shoot cadence

This is the most concretely reusable operational spec.

**Fatigue definition** ([how-we-combat-creative-fatigue](https://solaronsteroids.com/resources/how-we-combat-creative-fatigue-before-it-hits-performance)): "showing an ad too many times to the same audience… causes performance to decline," symptoms = "cost leads going up, engagements decreasing." Three counters: fresh footage (new sites/people/formats the algorithm rewards), new messaging concepts, new formats (the selfie/UGC walkthroughs). Production scale: a full-time designer churning out "around 50 image ads a week" (testimonials, carousels, USP variants).

**Shoot cadence tied to spend** ([how-we-film-based-on-your-ad-spend](https://solaronsteroids.com/resources/how-often-we-film-based-on-your-ad-spend)):
- **< £20k/month** → film once every 3 months
- **£20k–£40k/month** → twice per quarter
- **> £40k/month** → once every month

Rationale ([why-creative-volume-is-directly-linked-to-campaign-scale](https://solaronsteroids.com/resources/why-creative-volume-is-directly-linked-to-campaign-scale)): "creative volume is directly linked to scalability" — higher spend hits audiences more frequently, so it burns creative faster and needs a higher refresh rate. New ads launch continuously across the 90-day post-shoot window. (No published exact ads-per-£ formula.)

### 9. Why standard Meta lead forms are avoided (2026)

From [why-your-meta-ads-are-failing-in-2026](https://solaronsteroids.com/resources/why-your-meta-ads-are-failing-in-2026): native lead forms are rejected because "8% of all accounts on Meta are bots" that can fill them, no CAPTCHA is possible, and Meta only offers ~3 form variations. SOS instead funnels to external **Perspective** landing pages (up to 8 pages, CAPTCHA-capable, continuously testable). Published conversion-rate arc: launch at "2 or 3%," rise to "4–5%" after imagery tests, "7 or 8%" after headline testing; current portfolio average **5.5%**.

### 10. Top-of-funnel as a long-term CPL lever

From [why-top-of-funnel-solar-ads-can-produce-cheaper-leads-long-term](https://solaronsteroids.com/resources/why-top-of-funnel-solar-ads-can-produce-cheaper-leads-long-term): only "3% of the market is actively buying at any one time," so competing only for bottom-funnel intent is expensive. Their worked example: £10k on bottom-funnel ≈ 250 leads / 30 deals / £240k; same £10k on top-funnel ≈ 2,500 leads at "10% of the price" per lead / potentially 60 deals / £480k — but only viable on 6/12/24-month horizons, once bottom-funnel is stable, and *only if* low-friction entry (free guides/assets) plus automated nurture (email/WhatsApp/SMS) catch the not-yet-ready leads. This is the strategic bridge to your lifecycle-orchestration side: **top-of-funnel paid + nurture is where a Hogsend-style engine earns its keep.**

### 11. The CAPI feedback loop — the actual moat

This is the piece the whole rebuild hinges on ([/service/data](https://solaronsteroids.com/service/data)). The stated problem: most agencies "are unable to tell Facebook which leads are actually any good," so "Facebook's only option is to optimise to get the cheapest enquiries, even if they aren't the ones progressing." SOS's system tracks four datapoints — **initial submission info, session tracking, pipeline stage/status, deal value** — and dispatches sale/quote events with deal value back to Meta CAPI, matched via `fb_click_id` + `ad_id`.

Effects they claim:
- **Bidding shifts** from "cheapest leads" to prospects matching actual closing patterns → Meta can "find more people like the ones that you are actively pitching & closing" → "significantly higher lead quality."
- **Lead composition drifts over time**: if you rarely quote price-conscious buyers, "you'll gradually generate less and less of that kind of lead." The optimiser literally reshapes your audience toward margin.
- **Metric reframing**: away from "vanity metrics like cost per lead" toward **cost per quote / cost per sale and financial ROI**.
- **Cross-session first-touch stitching**: an FB click without a form fill, then a later organic/direct visit + form fill, is credited back to the originating ad via UID stitching.

Industry context confirms the mechanism is real and now table-stakes for Meta AI bidding: value-based bidding / value rules require "clean server-side data via CAPI… enabling it to bid aggressively on users who resemble highest-LTV customers" ([1ClickReport](https://www.1clickreport.com/blog/meta-value-rules-2025-guide), [Meta value-optimization docs](https://developers.facebook.com/documentation/ads-commerce/conversions-api/guides/value-optimization), [Stape profit-based optimization](https://stape.io/blog/meta-profit-based-campaign-optimization)). SOS's edge isn't the CAPI call itself — it's owning the **pipeline-stage + deal-value truth source** across many CRMs and reliably joining it to the click ID.

### 12. Published benchmarks (treat as marketing, directionally useful)

- **AJ Renewables** (their best-performing client): >£100k closed in 30 days at **£25 revenue per £1 ad spend (25× ROAS)**; later >£2M installations, multiple £300k+ months. CPL history: £39 → £67 (May–June), stabilised £51 (July), £44 (August) — i.e. CPL *rose* while they *scaled spend* and stayed profitable on a CPA basis (VERIFIED via [search of SOS materials](https://solaronsteroids.com/); the recon-brief "~£400 cost per sale" figure was not independently confirmed on the pages I could read — treat as unverified).
- **Activ8 (Ireland's largest installer)**: performance bet (free shoot, waived setup, £3k gifted spend, pay-only-if->3× improvement) delivered **5×**, CPL **-79%**.
- **Kimble Solar** ad: avg deal £15k+, surveyors fully booked.
- **Portfolio funnel CR average 5.5%**; ~8/51 creative launches "fail."
- Commercials: **min ad spend £2,500/mo** (higher tiers £20k/£40k unlock more shoots), setup fee exists, monthly rolling / no tie-in.

---

### What transfers to other verticals (rebuild lens — INFERRED)

The machine is vertical-agnostic *except* the shoot logistics. The reusable spine:
1. **A creative-taxonomy data model** — every asset tagged type (education/engagement/offer/social-proof) × format (video/image/UGC) × funnel stage, so cost-per-sale can be attributed by creative dimension, not just by ad ID.
2. **A spend-tiered creative-refresh scheduler** — codify §8's cadence table as a rule (spend band → shoot/refresh frequency → target live-ad count) so fatigue is prevented by policy, not noticed after CPL climbs.
3. **A discipline/rules layer over the ad account** (§1) — staged budget ramps, per-creative spend caps, minimum-data thresholds before reallocation; the anti-emotion "stop-loss."
4. **The pipeline-truth → CAPI value-optimization loop** (§11) — the genuine moat. It needs: a CRM plugin layer normalising *pipeline stage + deal value* across Attio/HubSpot/GHL/Pipedrive (both webhook AND polling, because CRMs differ), UID-based cross-session stitching to recover the click ID, and a value-event dispatcher to Meta CAPI (and other channels' equivalents). This is where your multi-model attribution engine plugs in: first/last/linear/time-decay/position-based/blended all consume the *same* stitched touchpoint-to-deal graph; CAPI just needs one canonical value + click-id per conversion.
5. **The video-first "educate to filter for margin" doctrine** (§6) — any high-consideration, high-ticket, trust-driven vertical (roofing, HVAC, med-spa, home improvement, B2B services) inherits it directly; low-ticket impulse verticals do not.

What does *not* transfer cheaply: the 500-shoot content-production machine and the installer-site access. For a rebuild, the software (taxonomy + cadence scheduler + CRM-to-CAPI value loop + attribution engine) is the durable IP; the shoot operation is the services layer SOS wraps around it — and notably the same IP they resell to other agencies for £40k–£100k.

---

### Sources
- https://solaronsteroids.com/service/facebook-ads
- https://solaronsteroids.com/service/videography
- https://solaronsteroids.com/service/reputation
- https://solaronsteroids.com/service/data
- https://solaronsteroids.com/resources/the-four-ad-types-that-actually-work-for-solar
- https://solaronsteroids.com/resources/breaking-down-a-high-performing-solar-ad-frame-by-frame
- https://solaronsteroids.com/resources/why-your-meta-ads-are-failing-in-2026
- https://solaronsteroids.com/resources/why-video-ads-produce-better-leads-than-image-ads
- https://solaronsteroids.com/resources/how-often-we-film-based-on-your-ad-spend
- https://solaronsteroids.com/resources/why-creative-volume-is-directly-linked-to-campaign-scale
- https://solaronsteroids.com/resources/how-we-combat-creative-fatigue-before-it-hits-performance
- https://solaronsteroids.com/resources/why-most-meta-ad-accounts-collapse-over-time
- https://solaronsteroids.com/resources/why-our-meta-ads-campaigns-perform-before-they-even-optimise
- https://solaronsteroids.com/resources/why-i%E2%80%99m-not-allowed-in-our-clients%E2%80%99-ad-accounts
- https://solaronsteroids.com/resources/why-top-of-funnel-solar-ads-can-produce-cheaper-leads-long-term
- https://www.1clickreport.com/blog/meta-value-rules-2025-guide
- https://developers.facebook.com/documentation/ads-commerce/conversions-api/guides/value-optimization
- https://stape.io/blog/meta-profit-based-campaign-optimization

## Key facts

- [VERIFIED] Shoot cadence is tied to ad spend: <£20k/mo = film every 3 months; £20k-£40k/mo = twice per quarter; >£40k/mo = monthly (how-often-we-film-based-on-your-ad-spend).
- [VERIFIED] SOS runs 20+ ads live simultaneously; real accounts cited at 37, 22, and 43 live ads; only ~8 failures out of 51 launches (why-most-meta-ad-accounts-collapse-over-time).
- [VERIFIED] They produce 15-20 new creatives daily across the portfolio and ~50 image ads/week from a full-time designer; mix is ~80% video.
- [VERIFIED] Four ad types: Education/Expertise (highest-performing), Engagement (humour/skits), Offer/Hard-CTA (works without a price), Social Proof (weak cold, strong in retargeting).
- [VERIFIED] Video ads filter for margin: image ads attract price-shoppers; educated video viewers accept premium pricing, so leads are 'way higher quality' (why-video-ads-produce-better-leads).
- [VERIFIED] Winning video formula: 0-10s authority hook (lead with credential), spec-then-layman translation, story-over-features, specific benefit CTA, hold-frame after CTA to stop Meta auto-advance (Kimble teardown).
- [VERIFIED] Selfie/UGC installer walkthroughs (minimal editing, subtitles+music+b-roll) are their primary anti-fatigue creative format and look like organic content.
- [VERIFIED] Reputation layer: low-production self-shot customer testimonials ('intentionally low production quality, far more believable') run as ads = 'turning customers into your sales team.'
- [VERIFIED] They avoid native Meta lead forms because '8% of Meta accounts are bots' can fill them, no CAPTCHA, only ~3 form variants; they funnel to Perspective (8 pages, CAPTCHA).
- [VERIFIED] Funnel conversion arc: ~2-3% at launch, 4-5% after image tests, 7-8% after headline tests; portfolio average 5.5%.
- [VERIFIED] Attribution tracks four datapoints (initial submission, session tracking, pipeline stage/status, deal value) and sends sale+value to Meta CAPI matched via fb_click_id + ad_id.
- [VERIFIED] CAPI feedback shifts Meta from 'cheapest leads' to closers' lookalikes and drifts audience away from price-conscious buyers over time; metric reframed to cost-per-quote/sale not CPL.
- [VERIFIED] Ad-account discipline: founder deliberately excludes himself; reactive scaling is 'trading with no stop-loss'; account governed by a structured testing/scaling framework, not gut.
- [VERIFIED] AJ Renewables: >£100k closed in 30 days at 25x ROAS; CPL rose £39->£67->£51->£44 while spend scaled and stayed CPA-profitable.
- [VERIFIED] Activ8 (Ireland's largest installer): performance bet delivered 5x with CPL -79%; min ad spend £2,500/mo, monthly rolling, setup fee.
- [VERIFIED] Top-of-funnel thesis: only 3% of market actively buying; TOF at ~10% of the CPL can yield more deals long-term but needs lead magnets + automated email/WhatsApp/SMS nurture and a 6-24 month horizon.
- [VERIFIED] A single shoot day yields 400GB-1TB footage / 100+ clips, powering 20-50 campaigns x 5-10 variants (up to 500 creatives) that run 3-6+ months without new assets.
- [VERIFIED] Videography backbone: 500+ systems shot; pro kit (Nikon Z6III, Sony A7SIII/A7IV/A6700, DJI drones/gimbals, Shure SM7B); ~45 min/property.
- [INFERRED] The durable, vertical-agnostic IP is the software spine: creative-taxonomy data model, spend-tiered refresh scheduler, ad-account rules/discipline layer, and the pipeline-truth->CAPI value loop; the shoot operation is the non-transferable services wrapper.
- [INFERRED] A multi-model attribution engine and the CAPI value dispatch consume the same stitched touchpoint-to-deal graph; CAPI needs one canonical value + click-id per conversion, so the CRM-normalization layer (stage+value, webhook AND polling) is the hard part.

## Open questions

- The recon-brief '~£400 cost per sale' AJ Renewables benchmark was not confirmed on any page I could read; the verified AJ figures are 25x ROAS and CPL £39-£67. Needs a primary source.
- The Meta Ad Library did not render server-side (socket hang up), so I could not directly enumerate SOS's or clients' live ads, formats, or copy — only their self-published breakdowns.
- Exact ads-per-£-spend ratio is never published; only the qualitative 'more spend = more creative' and the shoot-cadence tiers. The precise live-ad-count target per spend band is unknown.
- How SOS technically reconstructs the click_id on cross-session first-touch (FB click with no fill, later organic fill) — the UID-stitching mechanism and its match rate — is not detailed publicly.
- Whether they use Meta value-based bidding / value rules explicitly, or just standard conversion optimization on a custom 'sold' event with value, is not stated.
- The campaign-object structure (CBO/ABO, number of ad sets, audience definitions, budget-ramp thresholds) behind the 'disciplined scaling framework' is not disclosed.
- Which optimization event Meta bids on at each stage (lead vs quote vs sale) and the volume thresholds needed for the sale-level signal to leave the learning phase given solar's long sales cycle.
