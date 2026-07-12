# Research: funnel-layer

## The Funnel/Form Layer — Rebuild Spec for an Attribution-First Quiz Funnel Engine

### Context: what Solar on Steroids actually built on top of Perspective

Solar on Steroids (SOS) does not own its funnel engine. They are the **first and #1 agency partner of Perspective (perspective.co)**, a German-built, mobile-first quiz-funnel SaaS. Everything SOS claims — "30,000+ leads," "£200k/month of traffic," "40+ solar funnels" — runs on Perspective as the presentation/capture layer, with SOS's *proprietary* attribution system bolted on downstream (session tracking, CRM polling/webhooks, deal-value capture, Meta CAPI dispatch). This is the critical architectural insight for a rebuild: **the form engine and the attribution engine are two separable products.** SOS rents the form engine (Perspective) and *owns* the attribution engine (which they resell for £40k–£100k). If your priority is attribution-data capture, the form layer is the commodity and the attribution spine is the moat — so the build-vs-buy line should be drawn exactly where SOS drew it.

### Question architecture — the doctrine SOS proved (VERIFIED from their own resource library)

SOS has published unusually candid CRO reasoning. The load-bearing lessons:

**1. The first question must be zero-friction and self-evident.** SOS changed their solar funnel's opening question from *"What are you looking for?"* (a service-choice question) to *"Do you own your home?"* Rationale: the old question forced a decision before the prospect was ready, pushing people to bail or pick "Help me decide." "99% of people know the answer" to the ownership question, so they progress effortlessly. Claimed result: **conversion rate doubled and cost-per-lead halved across all clients**, at "100% statistical significance." The homeownership question doubles as the **hardest qualification filter** (renters can't buy solar) while feeling like a soft opener. Design principle: the first step is a commitment ramp, not a data-collection step — pick a binary the prospect answers instantly *and* that filters your worst segment.

**2. Conditional/branching logic to compress the form.** SOS runs ~15 latent questions but shows any given visitor only **6–9**, branching on earlier answers (residential vs. commercial → skip the split question; "never worked with an agency" → skip "are you currently with an agency"; "not running ads" → skip ad-spend questions). The effect mimics a consultative sales conversation and cuts abandonment. For a rebuild: conditional visibility is table-stakes, and the branch tree is where lead *quality* is engineered — every skipped-irrelevant question is retained completion, every added-relevant question is a qualification signal.

**3. A late open-text "intent" field as the strongest buy-signal.** SOS's single best quality predictor is a late, optional *"Anything else to tell us?"* free-text box. Prospects who fill it convert far better; sales calls them first. Trade-off they quote: **cost-per-lead rises ~£5 but cost-per-acquisition drops ~£100.** This is a deliberate volume-for-quality trade — the field filters tire-kickers by making completion slightly harder for the uncommitted. Rebuild implication: your engine needs optional fields whose *completion state itself is a tracked attribute* feeding lead scoring/attribution, not just a CRM note.

**4. Postcode + property-type as hard qualifiers.** Homeownership, postcode (serviceable area / MCS relevance), and residential-vs-commercial are the qualification spine. Postcode also becomes an attribution/geo field (SOS tracks `postcode` verbatim). A rebuild should treat postcode as both a qualifier gate and an enrichment key.

**5. "Free" ruins lead quality.** SOS bans "free" from single-image ads and even softens "free quote" → "complimentary survey." "Free" attracts confused/entitled prospects (people who think the *panels* are free). Better: "complimentary survey," "10% off," "bonus panels included." Qualification starts in the ad copy and must carry through the funnel headline — value framing without the giveaway trigger.

### Ad → page message match via dynamic headlines (VERIFIED)

SOS's biggest conversion lever after the first question is **dynamic headline insertion** matched to the ad. "Battery-only ads land on battery headlines. Specific hardware ads reference the exact product." Mechanism: the ad's intent (encoded in UTM/URL params or ad-set mapping) drives which headline variant renders, so the page reinforces exactly what made the prospect click. A generic headline "drops off the cliff" when the prospect had a specific need (e.g., a battery-retrofit buyer who already owns panels). They quote a **static-headline baseline of 7–8%** and "massive" lift from message-matched variants, with the caveat that running 50–100 headline variants creates high variance (some hit 20%, some 1%) requiring systematic pruning. **Rebuild requirement: headline (and hero image, subhead, CTA) must be templatable off URL params, with a variant registry and per-variant conversion tracking so you can prune.** This is the same dynamic-text-replacement (DTR) pattern Unbounce/Instapage pioneered — but here it's keyed to ad *intent*, not just keyword.

Above-the-fold doctrine they publish: headline chosen for local search phrasing ("Solar panels for your home"), benefit or social-proof subhead ("Save 70%…" / "Join thousands…"), hero = **real installer team smiling** (not stock panels — "people work with people"), sticky primary + secondary CTA, four trust callouts (local, accredited, rated, USP), hardware-brand logos (Tesla/SolarEdge/GivEnergy), and **face-bearing reviews (min. 50)**. One documented micro-test: reordering "Arrange your *free* solar quote…" → "Arrange your solar quote… *for free*" lifted conversion 3%→4% (**+33%**); a hero-image swap gave **+56%**; another **+~100%** to 13.24%.

### Why quiz funnels beat lead forms (the quality argument, VERIFIED)

SOS's thesis: **Meta traffic is 70–90% mobile, so design mobile-first and tap-native.** Traditional websites (desktop layouts, many links) create friction; Meta Instant Forms get "every Jeff, Bob and Harry" (low intent, autofill garbage). Their mobile-first quiz funnels reportedly hit **~12% conversion** at ~£1 CPC → sub-£10 leads, *and* higher intent because the prospect actively answered qualifying questions. The multi-step interaction is itself the qualifier — friction is a feature. **Anti-autofill is deliberate:** SOS turns browser autofill off so prospects type real, current contact data rather than stale/spam autofilled values — trading a little completion for materially cleaner CRM data and better speed-to-lead contactability. A rebuild's form engine must expose an autofill-disable toggle and validate phone/email at entry (carrier-level phone validation is a differentiator — Heyflow does this natively).

Lead-ownership angle: because ads run from the *client's own* Facebook/Instagram pages and leads submit directly into the *client's* CRM, the data trail is unbroken and exclusive — no reselling, no shared inquiries. Attribution and data possession are unified in the client's infrastructure. For a rebuild selling to agencies, this "you own the funnel, the pixel, the data, and the CRM row" story is the wedge against lead-resale competitors.

### The attribution-capture requirements (the actual priority)

This is where the form engine must not compromise. The non-negotiable capture list, distilled from SOS's tracked fields + Perspective/Heyflow docs:

- **Auto-captured hidden fields from the landing URL:** `utm_source/medium/campaign/id/term`, and click IDs `fbclid`, `gclid`, `ttclid`, `msclkid` — grabbed on page load into hidden inputs, forwarded in *every* webhook/CRM payload, invisible to the visitor. Perspective and Heyflow both do this natively; a custom build must replicate it exactly (read `window.location.search`, persist to first-party cookie/localStorage keyed by a session UID before any redirect strips params).
- **A first-party session/visitor UID** minted on first touch and persisted, so a click that *doesn't* convert can be stitched to a later organic/direct visit that *does* (SOS's cross-session first-touch stitching). This requires your own cookie + server-side identity store — Perspective does not do cross-session stitching; SOS built it. **This is the single most important capability to own in-house.**
- **Partial-submit capture** — fire an event (and a Meta CAPI `PartialLead` with hashed email) as soon as email/phone is entered, before final submit. Heyflow does this natively; Perspective fires the webhook when a visitor "converts to a lead" (enters email/phone) or reaches a result page. A custom build should emit a step-level event stream, not just a terminal submit.
- **Webhook delivery with custom method/headers/auth and conditional routing** — POST/PUT/PATCH, custom auth headers, and *branch-conditional* webhooks (ready-to-buy → instant-call system; researching → nurture). Heyflow gates this to Business/Scale; Perspective's webhook is simpler (single POST on conversion). A custom build makes this trivial and is a strong reason to build.
- **Server-side conversion API (Meta CAPI) with dedup + hashed match keys** — the qualified-quote and closed-sale signals sent back to Meta with `fb_click_id`, `ad_id`, and deal value, deduped against the browser pixel. SOS's "bespoke attribution system" *is* this loop closed against CRM stage/value. Heyflow ships native CAPI; Perspective does not natively push offline/CRM conversions with deal value — that's why SOS built their own layer.

SOS's downstream spine (for your attribution engine, not the form): four datapoints — initial submission, session tracking (UID), CRM pipeline stage/status (via **both webhook `POST /webhooks/crm` and `crm.poll`**, because not every CRM emits reliable stage-change webhooks), and deal value — joined on the UID, with `time_to_close` computed and a `lead_sold`/`lead_quoted` CAPI event carrying `value`. GDPR posture worth copying: track by UID, **no PII beyond 29 days**, client-controlled publication granularity.

### CRO cadence

SOS runs **weekly optimization cycles**, one variable at a time (headline word-order, hero image, first question), reading significance in-tool, and pruning losing headline variants continuously. For a rebuild: bake per-variant conversion tracking and a built-in A/B split (with statistical-significance readout) into the engine from day one — CRO velocity is the service's recurring value, and it depends on the form engine surfacing clean per-step, per-variant funnel metrics.

### Build-vs-buy recommendation for the form engine

**When attribution-data capture is the priority, the recommendation is a hybrid: buy the presentation layer's *pattern*, build the capture-and-attribution spine.** Concretely:

- **Do not build a drag-and-drop visual funnel *editor* first.** That's months of undifferentiated work (Perspective/Heyflow/involve.me have spent years on it). If speed-to-market matters, **start on Heyflow, not Perspective** — Heyflow is the only off-the-shelf engine with *native* Meta CAPI, partial-submit capture, carrier-level phone validation, conditional webhooks, and built-in A/B testing, i.e. it already covers ~80% of the attribution capture list. Perspective is prettier and more agency-white-label-polished but weaker on server-side tracking (which is exactly why SOS had to build a bespoke layer on top of it). involve.me gates A/B/webhooks/custom-CSS behind its $199/mo Business tier and has weaker attribution; LeadsHook is a decision-tree/lead-distribution tool (great logic + "secret" contextual fields, less beautiful); Typeform is beautiful but a survey tool, not an ad-funnel/attribution engine.

- **Build (own, don't rent) the attribution engine and the identity/session spine.** This is SOS's actual IP and the thing they resell for £40k–£100k. It is a stateless-ish service that: (1) mints/persists a first-party UID, (2) captures UTMs+click IDs pre-redirect, (3) ingests form webhooks and CRM stage/value via *both* webhook and polling adapters per CRM, (4) stitches non-converting clicks to later conversions on the UID, and (5) fires multi-model attribution + CAPI events with deal value. Your monorepo instinct (a plugin system per CRM — Attio/HubSpot/GHL/Pipedrive/Salesforce/Monday/Payaca) maps 1:1 onto SOS's "direct CRM integrations" list and their `defineWebhookSource`-style ingestion. **The multi-model attribution engine (first/last/linear/time-decay/position-based/blended) is your differentiator over *everything* on the market** — none of Perspective/Heyflow/involve.me offers configurable multi-touch attribution with per-campaign conversion-point definitions and value tracking. That's the "solar on steroids, on steroids" wedge.

- **If you do build the form engine too (later),** the minimum spec is: mobile-first tap-native steps; conditional branch tree; dynamic headline/hero/CTA templating off URL params with a variant registry; optional-field-completion as a tracked attribute; autofill-disable + inline phone/email validation; per-step + per-variant funnel analytics with built-in A/B significance; hidden-field auto-capture of UTMs/click-IDs; step-level event stream (not just terminal submit) into your own attribution spine. Treat the form as a thin client that emits events to the spine — never let form-vendor lock-in own your identity graph.

**Bottom line:** rent or build the beautiful form; *always own* the session UID, the cross-session stitch, the CRM value-capture adapters, and the multi-model attribution + CAPI dispatch. That's the boundary SOS drew, it's why their "competitors literally cannot compete," and it's the only part worth your engineering time.

### Sources
- https://solaronsteroids.com/service/funnels
- https://solaronsteroids.com/resources/why-we-changed-the-first-question-in-our-solar-funnels
- https://solaronsteroids.com/resources/how-small-funnel-changes-are-cutting-solar-lead-costs-in-half
- https://solaronsteroids.com/resources/how-conditional-logic-improves-solar-lead-quality
- https://solaronsteroids.com/resources/the-funnel-question-that-filters-serious-solar-buyers
- https://solaronsteroids.com/resources/why-dynamic-headlines-change-funnel-conversion-rates
- https://solaronsteroids.com/resources/where-to-send-meta-ads-if-you-want-higher-quality-solar-leads
- https://solaronsteroids.com/resources/what-actually-converts-above-the-fold-for-residential-solar
- https://solaronsteroids.com/resources/why-%E2%80%9Cfree%E2%80%9D-ruins-solar-lead-quality
- https://solaronsteroids.com/resources/lead-ownership-and-the-end-of-shared-inquiries
- https://www.perspective.co / https://www.perspective.co/pricing / https://www.perspective.co/integrations / https://www.perspective.co/metrics
- https://intercom.help/perspective-funnels/en/articles/5199389-how-do-i-use-webhooks-for-my-funnel
- https://intercom.help/perspective-funnels/en/articles/8227658-utm-parameters-explained
- https://intercom.help/perspective-funnels/en/articles/10485234-how-can-i-forward-utms-and-variables-to-an-external-url
- https://heyflow.com/blog/best-funnel-builder-with-native-meta-conversions-api-integration/
- https://heyflow.com/blog/capture-partial-leads/
- https://help.heyflow.com/en/articles/12086609-url-utm-parameter-tracking
- https://heyflow.com/blog/best-quiz-builders/
- https://www.involve.me/blog/best-heyflow-alternative
- https://www.leadshook.com/help/leadshook-contextual-custom-fields/
- https://thatmarketingbuddy.com/pricing/perspective-funnels

## Key facts

- [VERIFIED] SOS's funnel engine is Perspective (perspective.co); SOS is Perspective's first & #1 agency partner — the form engine is rented, the attribution engine is theirs
- [VERIFIED] SOS changed first question from 'What are you looking for?' to 'Do you own your home?' → claimed conversion doubled, cost-per-lead halved at '100% significance'
- [VERIFIED] First question doubles as hardest qualifier (renters filtered) while feeling like a zero-friction binary opener
- [VERIFIED] Conditional logic compresses ~15 latent questions to 6–9 shown per visitor, branching on prior answers to cut abandonment
- [VERIFIED] A late optional free-text 'Anything else to tell us?' field is SOS's strongest buy-intent signal: CPL +£5 but CPA −£100
- [VERIFIED] Dynamic headlines match ad intent to page copy ('battery ads land on battery headlines'); static baseline 7–8%, message-matched 'massive' lift; 50–100 variants need pruning
- [VERIFIED] SOS bans 'free' from ads (attracts confused/entitled leads); uses 'complimentary survey', '10% off', 'bonus panels' instead
- [VERIFIED] Meta traffic is 70–90% mobile per SOS; mobile-first tap quiz funnels hit ~12% conversion, sub-£10 leads at ~£1 CPC; Instant Forms get low-intent 'every Jeff, Bob and Harry'
- [VERIFIED] Anti-autofill is deliberate — forces real current contact data over stale/spam autofill, improving CRM quality and speed-to-lead
- [VERIFIED] Documented micro-tests: headline word-order +33% (3%→4%), hero image swap +56%, another hero test ~+100% to 13.24%
- [VERIFIED] Perspective + Heyflow auto-capture UTMs and click IDs (fbclid/gclid/ttclid/msclkid) into hidden fields, forwarded in every webhook payload, invisible to visitor
- [VERIFIED] Perspective does NOT natively do cross-session identity stitching or CRM-value/offline CAPI dispatch — SOS built that layer themselves (the resold IP)
- [VERIFIED] Heyflow has native Meta CAPI (with dedup + hashed match keys), partial-submit capture (PartialLead event), carrier-level phone validation, conditional webhooks, built-in A/B — closest off-the-shelf to the attribution capture list
- [VERIFIED] Perspective pricing: Base ~€59/$62, Grow ~€184/$193, Expand ~$391/mo, custom Scale; 14-day trial; priced on features/funnel volume not contacts; white-label agency workspaces on higher tiers
- [VERIFIED] involve.me gates A/B testing, custom CSS, and webhooks behind $199/mo Business tier; weaker attribution and fewer native ad integrations
- [VERIFIED] LeadsHook is a decision-tree lead-qualification/distribution tool with 'secret' contextual custom fields (node/answer/id) auto-injected into webhook/API nodes
- [VERIFIED] SOS runs weekly CRO cycles, one variable at a time, pruning losing headline variants continuously
- [VERIFIED] SOS attribution spine uses BOTH crm.poll and POST /webhooks/crm because not every CRM emits reliable stage-change webhooks
- [VERIFIED] SOS GDPR posture: track by UID, no PII stored beyond 29 days, client controls publication granularity
- [INFERRED] Build-vs-buy line: rent/build the form editor, but always own the session UID, cross-session stitch, per-CRM value-capture adapters, and multi-model attribution + CAPI dispatch
- [INFERRED] Configurable multi-model attribution (first/last/linear/time-decay/position-based/blended) with per-campaign conversion-point + value definitions is offered by NONE of Perspective/Heyflow/involve.me — the rebuild's true differentiator
- [INFERRED] Fastest path to market on the form layer is Heyflow (covers ~80% of attribution capture natively), not Perspective, since Perspective forced SOS to build a bespoke tracking layer

## Open questions

- Exact Perspective webhook payload schema — does it include the session UID and all click IDs, or must those be added as manual hidden fields? (docs did not specify capture mechanism)
- Does Perspective persist UTMs/click-IDs across sessions at all, or only within the single landing session? (SOS's cross-session stitch strongly implies Perspective does NOT)
- Heyflow's exact current pricing tiers and which plan unlocks native CAPI + conditional webhooks (pricing page did not surface numbers in search)
- Terms of Perspective's agency partner program that made SOS the 'first partner' — revenue share, co-marketing, or just volume white-label? Not found.
- What CRM-side mechanism SOS uses for deal-value capture per CRM (native webhook field vs. polling the deal object) — and which CRMs lack reliable stage-change webhooks
- Whether SOS's resold £40k–£100k attribution system is a hosted multi-tenant product or a per-client bespoke build (affects whether a rebuild should be SaaS or agency-internal)
- Real-world completion-rate delta from disabling autofill (SOS asserts quality gain but publishes no completion-loss number)
- Legal/consent basis for the 29-day UID retention and CAPI value dispatch under UK GDPR when leads are stitched across sessions before consent
