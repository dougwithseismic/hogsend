# Impact — journey & event attribution, influence, and incrementality — the plan

> Status: **scoping** (research complete 2026-07-13; no code). Research basis: 107-agent deep-research pass (25/25 claims adversarially verified against primary vendor docs) + full internal seam map (§2). Predecessor: `docs/revenue-attribution-plan.md` (Phases 1–6 shipped the spine this plan generalizes). Sequencing: lands AFTER the 0.44.0 release line ships.

**The promise this plan exists to deliver:** adopt Hogsend and you know what your lifecycle work is doing to revenue and to your funnel from the first week — per journey, per campaign, per channel, per event, under any attribution lens, with an honest split between *attributed*, *influenced*, and *incremental*. Generic toolset: B2C (orders, subscriptions, upgrades) and B2B (deals, stages) are the same machinery — a funnel is a ladder of milestones, a conversion is a valued event, and nothing assumes a CRM exists.

---

## Execution checklist

Legend: `[ ]` todo · `[~]` built-to-seam (human ask recorded) · `[x]` done. One commit per feature; phase-boundary simplify pass commits separately; calm-release discipline (one release line per phase, Version Packages PR merged LAST).

**Phase 1 — Scope-dimensional credit (the journey-blindness fix)**
- [x] **1.1 `campaign_id` column on `email_sends`.** Real column (nullable uuid/text), written by the campaign send path; keep the `campaign:<id>:<step>:<email>` idempotency-key convention for dedup but stop being the only carrier of campaign identity. Backfill migration parses existing idempotency keys into the column (`campaignSendKeyPattern` already exists). Same treatment for `sms_sends` if campaigns ever send SMS steps (check; if not, note the seam).
- [x] **1.2 Stamp scope onto touch events.** `resolveEmailSendContext`/`resolveSmsSendContext` additionally select `journey_states.journeyId` and the new `campaign_id`; `pushTrackingEvent`/`pushSmsTrackingEvent` stamp `journeyId?`/`campaignId?` into event properties alongside `templateKey`. Managed-link (`link.clicked`) and vanity-arrival events keep their existing `campaign` label; semantic-click (`email.action`) inherits via the same resolver. Zero new tables — the spine carries scope.
- [x] **1.3 Scope columns on the credit ledger.** `attribution_credits` gains nullable denormalized `journey_id`, `campaign_id`, `template_key`, `funnel_id`. `recordAttributionCredits` resolves them per touchpoint (from the stamped properties; fallback join `emailSendId → email_sends → journey_states` for events emitted before 1.2). "This journey attributed £X under time-decay" becomes a WHERE clause — the ledger's whole design promise, now with the dimensions that matter.
- [x] **1.4 Persist + wire `ConversionMeta.scope`.** The existing descriptive `scope?: { journeyId?, campaignId? }` (`packages/core/src/conversions.ts:31`) gets persisted onto `conversions` rows and becomes filterable in admin/Studio. Still not an evaluation gate (the trigger decides what fires) — it's a reporting dimension + default filter for journey-scoped conversion points.
- [x] **1.5 Admin + Studio: revenue by journey/campaign/template per model.** Extend `GET /v1/admin/attribution` with `groupBy=journey|campaign|channel|template` (+ existing model × currency); Studio Impact surface shows a journey list with attributed value per selected model, drill-down to per-template. Journey detail page gets a revenue panel.
- **Ship:** "every journey and campaign shows the revenue it attributed, switchable across all eight models, with the Unattributed delta still explicit."

**Phase 2 — Windows, winner semantics, and honest dedup**
- [x] **2.1 Per-channel attribution windows.** `defineConversion` gains `windows?: { email?, sms?, campaign?, link?, form? }` (durations; default = current single `attributionWindowDays`). Ledger writer filters touchpoints per-channel. Industry convention (Klaviyo email 5d / SMS 1d-click 5d / push 24h) becomes documented defaults; everything configurable. Existing single-window definitions unchanged (zero breaking).
- [x] **2.2 Headline winner view (`lastTouch` single-credit).** A "headline" report mode that mirrors what Klaviyo/Braze users expect: ONE full-credit winner per conversion (most recent qualifying touch within its channel window), reported per journey/campaign. This is `last` model + per-channel windows — already in the ledger, surfaced as the comparable number for people migrating from incumbent tools. Never presented as the only number.
- [x] **2.3 Overlap transparency (the anti-Braze).** Research finding: no incumbent dedupes credit across journeys/campaigns — Braze documents conversion rates >100%. We do NOT silently dedupe either (fractional models already sum to 1 per conversion — that's the real dedup); instead the Studio rollup adds an explicit overlap read-out: conversions credited to >1 scope, and the % of scope-summed value that double-counts under single-credit lenses. Same honesty pattern as the existing Unattributed bar.
- [x] **2.4 Touch hygiene audit.** AUDIT RESULT: opens excluded (class list), SMS + managed-link bus ingests already bot-gated, arrivals JS-gated + ref-capped, semantic answers burst-confirmed — but the EMAIL click bus re-ingest was NOT bot-gated (SafeLinks-style scanners minted `email.link_clicked` touches + phantom journey triggers). Fixed: `!isBot` gate on the email-branch bus ingest; stats writes stay unconditional. Guarantee documented in docs/tracking.md §Touch hygiene. Opens stay excluded (validated: post-MPP open-crediting is the known inflation vector; Klaviyo defaults to excluding MPP opens). Verify bot-click filtering is applied before credit (click pipeline `isBot` gate) and document the guarantee. Retroactive reprocessing on window config change: NOT built (ledger is written at conversion time by design) — document that window changes apply forward, with 5.1 backfill as the escape hatch.
- **Ship:** "per-channel windows, a Klaviyo-comparable headline number, and an overlap report nobody else will show you."

**Phase 3 — Influenced + milestones + funnel progression (the non-monetary half)**
- [x] **3.1 `influenced` as a first-class metric.** Model-invariant coverage number (Dreamdata semantics): a conversion/milestone is *influenced by* scope S if the contact had ≥1 touchpoint from S inside the window. Deliberately multi-counted across scopes (documented as a reach metric, not a credit metric — it never sums to total). Cheap query over `attribution_credits` (any model, weight ignored) + admin endpoint + Studio column next to attributed.
- [x] **3.2 Milestones — value-optional conversion points.** DECIDED lean (per §5 Q4): docs-only convention, no `kind` field. Value-optional definitions already fire + earn weight-only credits (value NULL) end-to-end; convention documented on `ConversionMeta`. `defineConversion` already fires on unvalued events; formalize: a *milestone* is a conversion definition whose meaning is progress, not money (`kind: "milestone"` sugar or just docs + UI grouping — decide lean). B2C examples: `activation.completed`, `subscription.started`, `order.completed`; B2B: canonical stage events. Milestones get credits in the ledger like any conversion (weight-only, value NULL) — "which journeys drive activation" without a currency in sight.
- [x] **3.3 Event-ladder funnels (B2C parity with CRM funnels).** `defineFunnel` today is CRM-claims-shaped (`sources: { provider: stageMap }`). Add event-based stages: a stage may declare `event: "trial.started"` (+ optional `where`) instead of a CRM stage claim; the deals-projection equivalent for event funnels is a thin `funnel_progress` per-contact projection (contact, funnelId, stage, stageRank, reachedAt) written at ingest. One funnel primitive, two stage sources — a SaaS self-serve funnel and a sales pipeline are the same object.
- [x] **3.4 Progression + velocity reports.** Shipped for event-ladder funnels (`GET /v1/admin/funnels/:id/progression`): per-stage reach, per-transition conversion + median-days velocity, exposed-vs-unexposed split by journey/campaign scope, `correlational: true` stamped on the response. EV-weighted pipeline deliberately NOT built here — it is deals-shaped and the deals dashboard already reports open pipeline by stage; revisit if event funnels grow value semantics. Per scope S and funnel stage transition A→B: reach rate (contacts at A exposed to S who reached B within T) vs unexposed baseline, and median time A→B (velocity), exposed vs not. Expected-value pipeline: stage-probability × value from historical transition rates (uses `deals.stageRank`/`funnel_progress`). **Labeled correlational in the UI** ("associated with", never "caused") unless holdout-backed (Phase 4) — the honest-labeling rule is a design decision, not a nicety.
- **Ship:** "journeys measured by what they move — activation, stages, velocity — not just what they cash."

**Phase 4 — Incrementality (holdouts; the only causal number)**
- [ ] **4.1 Journey holdout primitive.** `defineJourney` meta gains `holdout?: { percent: number }`. Diversion runs in the enrollment guard chain (`execute-journey-run.ts`, between the preferences guard and enrollment insert, ~`:305`), **deterministic hash bucket** of `(userId, journeyId, salt)` — the replay law forbids RNG/clock in durable paths. Held-out contacts get a `journey_states` row with status `held_out` (or context tag — decide with the schema) AND a `journey.heldout` event on the spine (the Iterable Send Skip pattern: the counterfactual is data, queryable, fan-out-able). Guards order preserved: a contact who'd have been blocked by entry limits/preferences is NOT counted as held out (intent-to-treat hygiene — holdout must mirror the would-have-entered population).
- [ ] **4.2 Lift reporting.** Per journey-with-holdout: conversion/milestone/revenue rate for entered vs held-out, lift % ((t−c)/c), and a win-probability presentation with a **minimum-sample suppression floor** (Klaviyo suppresses under ~10 combined conversions; we pick and document our floor). Attributed and incremental shown side by side, never merged. Small-N warning when the control cohort is under a stated floor (Braze's rule of thumb: ~1,000; ours can be lower with the suppression + wide-interval presentation, but the warning is loud).
- [ ] **4.3 Global control group.** Contact-level deterministic bucket (1–15%, config) excluded from all non-transactional journey/campaign sends; transactional + connector-critical sends exempt by category (the existing category/preferences machinery is the gate). Emits `contact.control_group` marker; reporting = program-level lift. Explicitly optional — at SMB volume the per-journey holdout is the workhorse; the global group is for deployments with the scale to afford it (research: Klaviyo gates this at 400k profiles — we gate by warning, not by lockout).
- [ ] **4.4 PostHog interop.** Holdout membership fans out as a person property via the existing destinations spine (`hogsend_holdout: journey-x` / `control_group: true`) so PostHog Experiments/insights can slice by it. We own the lift math in Studio (self-hosted sovereignty); PostHog gets the raw material. NOT building on PostHog's holdout feature for assignment — enrollment must be decided inside the engine's durable path.
- **Ship:** "the incremental number — what would NOT have happened without the journey — with honest statistics at self-hosted volumes."

**Phase 5 — Day-one story (backfill + zero-config defaults)**
- [ ] **5.1 Attribution backfill command.** `hogsend attribution backfill [--definition X] [--since date]`: replays historical `user_events` through conversion evaluation + ledger writing (both already idempotent: unique `(definitionId, eventId)` and `(conversion, model, touchpoint)`). An EXISTING deploy that upgrades gets its history credited in minutes; a definition/window change gets a clean recompute path (delete-then-refill scoped to a definition, guarded + logged).
- [ ] **5.2 Zero-config revenue conversion.** Ship a default built-in conversion definition (`revenue`, enabled unless disabled): any server-source event with `value > 0` fires it. A fresh adopter who ingests one Stripe/order webhook sees the Impact tab populate with NO configuration. The seeded PostHog destination pattern is the precedent for opt-out defaults.
- [ ] **5.3 First-week checklist + docs.** `/docs/impact` guide: instrument arrival capture (`@hogsend/js` — 2 min), point one revenue webhook at a source (10 min), optionally define one funnel + one milestone; what you see on day 1 (touches, influenced), day 3 (first credits), day 7 (per-journey attributed + first lift read if holdout on). The adoption promise, written as a checklist we can defend.
- [ ] **5.4 Readiness surface.** Extend the existing readiness/admin checks: "attribution readiness" = arrival capture seen? valued events flowing? conversions firing? credits accruing? — so "how's it doing" has an answer even when the answer is "not wired yet, here's the missing wire."
- **Ship:** "adopt Hogsend, know your numbers in week one — and if you already run Hogsend, know them for your whole history today."

**Phase 6 — Gated future (explicitly NOT now)**
- [ ] **6.1 Data-driven models (Markov removal-effect, Shapley).** Behind a volume gate: only offered when the deployment clears ~400 conversions/definition/30d and ~10k multi-touch paths (GA4's own DDA floor). The ledger's `model` column is text — new models append without migration. Below the gate they're noise wearing a lab coat.
- [ ] **6.2 CUPED variance reduction for lift.** Worth it only once holdouts are humming; known limitation: useless for new-user journeys (onboarding — no pre-period), which are exactly our common case. CUPED++-style covariates are the researchable follow-up.
- [ ] **6.3 Spend/ROAS decision.** Deferred Phase 7 (spend ingestion) gets re-decided as integrate-vs-build: PostHog marketing analytics (beta) already syncs spend from 8 ad platforms; if it GAs, Hogsend reads spend from PostHog rather than polling Meta Insights itself. Revisit when the beta stabilizes.

---

## 1. Research basis (2026-07-13, adversarially verified unless marked ◇)

### 1.1 How incumbents compute "this flow drove $X" — and where it's weak

| Tool | Mechanic | Window defaults | Dedup scope |
|---|---|---|---|
| Klaviyo | Last-touch: single most recent *qualifying* message per channel window | email click/open 5d, SMS click 5d, push open 24h (config to 90d) | across its own channels via "most recent qualifying"; MPP opens + bot clicks excludable (bot default-on for new accounts) |
| Braze | Last-*received* Canvas step (delivery, not engagement); one conversion per event per Canvas entry | ≤30d, default 3d, runs from Canvas ENTRY | within one campaign/Canvas only |
| Iterable | Most recently *SENT* campaign with active window (no engagement condition at all), or explicit campaignId in the tracking call | per-campaign | last-touch across overlapping campaigns |
| Customer.io | Per-goal basis selectable: **sent**, opened, or clicked | up to 90d | none — "we count conversions independently for each campaign" |

The endemic weakness (vendor-documented, admission-against-interest): **no cross-object dedup**. Braze: "each channel has its own conversion opportunity… which can result in conversion rates exceeding 100%." Braze Canvas "Total Revenue" counts purchases that aren't even the configured conversion event. Summed "attributed revenue" across flows/campaigns systematically double-counts everywhere. Sources: help.klaviyo.com/hc/en-us/articles/1260804504250 + 11118357030555; braze.com/docs …/conversion_events + …/measuring_and_testing_with_canvas_analytics; support.iterable.com/hc/en-us/articles/27303602165396; docs.customer.io/journeys/send/campaigns/conversions.

**Implication for us:** fractional models summing to 1 per conversion (already true) ARE the dedup; the differentiator is *showing* the overlap (Phase 2.3) and keeping the Unattributed delta explicit (already shipped, #425) instead of inflating quietly.

### 1.2 Incrementality — the honest number nobody gives SMBs

- Braze Global Control Group: 1–15% of the base, recommended control floor ~1,000 users; reports uplift % + caused-conversion counts. Canvas control variants report "Uplift against the control variant" + "Statistical confidence" side-by-side with attributed numbers.
- Klaviyo global holdouts: **gated at 400k profiles**, ~5% held 3 months, one active group at a time; lift % + win probability, suppressed when treatment+holdout ≤ 10 conversions.
- Iterable: holdout inside campaign experiments; each held-out user gets a first-class **`emailSendSkip` event (reason `ExperimentHoldOut`)** on the profile — the counterfactual as data — but reporting is just skip count + holdout conversion %, no lift stat.

Sources: braze.com/docs/user_guide/audience/global_control_group (+ resources article); help.klaviyo.com/hc/en-us/articles/18138290642971; support.iterable.com/hc/en-us/articles/360058309172.

**Implication:** platform-native global incrementality is inaccessible at self-hosted/SMB volumes across the industry. Per-journey holdouts with honest small-sample presentation (suppression floors, loud warnings) is the accessible, differentiating grain. Iterable's Send Skip is the pattern to steal (Phase 4.1's `journey.heldout`).

### 1.3 Data-driven attribution — when it's real and when it's noise

- Google removed rules-based models from Ads/GA4 (Oct 2023) citing "<3% usage" and journey complexity — **not** methodological proof DDA wins at all volumes (ads-developers.googleblog.com 2023-04). Last-click retained.
- ◇ GA4 DDA's own floor: ~400 conversions/type/30d + ~10k multi-interaction paths (practitioner-sourced; matches Google's documented eligibility history). Below that, Markov/Shapley outputs are unstable.
- Multi-model persisted ledgers + side-by-side comparison is exactly what HubSpot ships to enterprises (swappable rule-set models); our all-models-at-write ledger is the same idea with better durability.

**Implication:** current 8-model ledger is defensible best-in-class; DDA is a Phase-6 volume-gated append, not a rewrite.

### 1.4 Influenced vs attributed vs incremental — the three-number semantics (◇ primary-sourced)

- Dreamdata: **influenced** = any lead/deal with ≥1 touchpoint from the scope — model-invariant, deliberately multi-counted, a *coverage* metric; **attributed** = fractional credit that sums to total — a *credit* metric. Two different questions, two first-class numbers (docs.dreamdata.io …/influenced-vs-attributable).
- HubSpot multi-touch revenue attribution: credit anchored at four funnel checkpoints (First Interaction, Lead Creation, Deal Creation, Closed-Won) — attribution computed per stage transition, not only at the sale; Enterprise-gated and deals-shaped (needs CRM deals to function at all).
- Salesforce campaign influence: "influenced" literally = a CRM join (campaign member ∩ contact role on open opportunity) — relationship-based, not event-based.

**Implication:** the three-number frame (attributed / influenced / incremental) is established practitioner semantics in B2B; nobody delivers it event-natively AND generically for B2C. That's the Impact surface's thesis. HubSpot's checkpoint anchoring validates milestone-level credit (Phase 3.2) — and its Enterprise+CRM gating is the accessibility gap we walk through.

### 1.5 PostHog 2026 — integrate vs differentiate (deprecation VERIFIED live 2026-07-13)

- **Revenue analytics dashboard removed on/after 2026-06-30** — replaced by revenue as person/group properties for insights/SQL. PostHog is exiting the opinionated revenue-reporting business.
- ◇ Marketing analytics: opt-in beta; UTM-based campaign→conversion mapping with cost-side metrics (spend synced from 8 ad platforms: Google/LinkedIn/Meta/Pinterest/TikTok/Reddit/Bing/Snapchat); **no credit allocation, no attribution models, no journey dimension**.
- ◇ PostHog Experiments has native holdouts (1–10% guidance, locked once launched, framed for long-term effects), analyzed as a variant with credible interval + win probability.

**Implication:** journey-grain, model-switchable, event-native revenue attribution is OPEN SPACE — PostHog just vacated the reporting layer and never had the credit layer. We push our numbers INTO their person properties (destinations spine already does person-sync); we read their spend if/when the beta GAs (Phase 6.3); we own assignment + lift math ourselves (Phase 4.4).

### 1.6 What did NOT survive verification
Loops' attribution mechanics; formal CUPED/ghost-control minimum-sample math; Markov/Shapley holdout-validated accuracy thresholds. ◇-marked items above are primary-sourced but not adversarially verified — re-verify before quoting externally.

---

## 2. Internal seam map (verified against source 2026-07-13)

What exists (build on, don't rebuild):

| Surface | State |
|---|---|
| `user_events` + first-class `value`/`currency` | THE spine; conversions + touches + milestones all ride it |
| Touchpoint classifier (`packages/core/src/attribution/touchpoints.ts`) | 5 channels, click-grade only, opens deliberately excluded, `extra` extension hook |
| `defineConversion` (`packages/core/src/conversions.ts`) | trigger+where, valueSource, `sources` forged-value guard, single `attributionWindowDays` (default 90), destinations |
| `@hogsend/attribution` | 8 pure-function models; all computed at conversion time |
| `attribution_credits` (`packages/db/src/schema/attribution-credits.ts`) | all-models ledger; unique (conversion, model, touchpoint); denormalized event/channel/time — **no scope columns** |
| `GET /v1/admin/attribution` + Studio AttributionPanel | model × channel × currency + coverage totals + Unattributed bar (#425) |
| `defineFunnel` + `deals` projection | CRM-claims stages, `funnel_id` + `canonical_stage` + `stageRank`; money events carry funnel context in properties |
| Destinations spine + seeded PostHog preset | email-funnel events + person sync today; conversions/credits NOT forwarded |

The gaps this plan closes (all confirmed by direct code read):

1. **Credit path is journey-blind and campaign-blind.** `resolveEmailSendContext` (`packages/engine/src/lib/tracking-events.ts:22-53`) joins `email_sends → journey_states` but never selects `journeyId`; touch properties carry only `emailSendId`/`templateKey`/`linkId`. `recordAttributionCredits` (`packages/engine/src/lib/attribution.ts`) matches touches purely by `userId` + event class.
2. **Campaign identity has no column.** It lives in `email_sends.idempotency_key` strings (`campaign:<id>[:<step>]:<email>`, `packages/engine/src/lib/campaign-send-key.ts:22-30`); stats match by LIKE. Campaign sends have `journeyStateId = NULL`.
3. **`ConversionMeta.scope` is inert** (`packages/core/src/conversions.ts:27-31`) — descriptive, not persisted, not filtered.
4. **No holdout/variant/control primitive anywhere.** Clean diversion slot: `execute-journey-run.ts` first-entry guard chain (enabled → config → trigger.where → entry limit → prefs → insert), between prefs (`:301-304`) and the active-state/insert block (`:306-335`). Must be hash-deterministic (replay law: no RNG/clock in durable paths). `journey_states` has no variant column; `context` jsonb is the migration-free fallback.
5. **Outbound `CrmDealEventPayload` drops `funnel_id`** (`packages/engine/src/lib/outbound.ts:240-249`) — internal bus carries it, destinations don't. Fix rides along with Phase 1.3.
6. **No progression projection for non-CRM funnels** — `deals` exists for CRM; event-ladder funnels need the thin `funnel_progress` sibling (Phase 3.3).

---

## 3. Design decisions (settled)

1. **Three first-class numbers, never blended.** *Attributed* (fractional credit, sums to total, model-switchable), *influenced* (coverage, model-invariant, multi-counted BY DESIGN), *incremental* (causal, holdout-backed, the only number allowed to say "caused"). Every Impact surface labels which number it is showing. No composite "impact score."
2. **Generic before vertical.** A funnel is an ordered ladder of milestones; a milestone is a (possibly valued) conversion definition; a stage source is either a CRM claim (existing) or an event matcher (new). B2C order-flow and B2B pipeline are configurations of the same three primitives — no `deal` assumptions outside the CRM plugins.
3. **The ledger stays write-once at conversion time; scope is denormalized in.** We extend the ledger's columns, not its philosophy. Model/window changes apply forward; the backfill command (5.1) is the deliberate, logged recompute path — never silent rewrites of history.
4. **Correlational numbers are labeled correlational.** Exposed-vs-not progression comparisons ship with "associated" language and a visible selection-bias caveat. Only Phase-4 holdout output earns causal language. This is a product stance, not a footnote — it's what "deliver confidently" means.
5. **Honesty artifacts are features.** Unattributed delta (shipped), cross-scope overlap % (2.3), small-sample suppression + warnings (4.2), attribution-readiness panel (5.4). The pitch is "numbers you can defend," because the incumbents' documented weakness is numbers you can't.
6. **Deterministic assignment only.** Holdout membership derives from stable hashes on the durable path; the counterfactual is materialized as spine events (`journey.heldout`), so it's queryable, exportable, and replay-safe like everything else.
7. **PostHog: push our numbers out, read their spend in, own assignment + math ourselves.** Their revenue-dashboard exit makes Hogsend the revenue-reporting layer of the stack; person-property fan-out keeps PostHog insights useful; no load-bearing dependency on their beta surfaces.
8. **Windows are per-channel, defaults documented, changes forward-only.** Klaviyo-convention defaults (email 5d, SMS 1d, etc.) so migrating operators see comparable numbers on day one; the headline `lastTouch` view exists precisely for that comparison, always alongside the fractional models.

## 4. New events / catalog chores (standing gotchas)

- New event types (`journey.heldout`, `contact.control_group`, funnel-progress events if 3.3 emits them) → `WEBHOOK_EVENT_TYPES` + BOTH vendored catalog copies (`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`).
- New engine npm deps (none expected) would need the create-hogsend template `_package.json` mirror.
- Drizzle partial-index `onConflict`: arbiter predicate is `where` (42P10 trap) — relevant to `funnel_progress` upserts.
- Hatchet journal is positional; holdout diversion must not reorder existing awaited calls in `executeJourneyRun` for in-flight runs — divert BEFORE any durable wait is established (the guard chain runs pre-`run()`, so this holds; keep it that way).
- Migration numbering: coordinate with whatever 0.44.x lands first.

## 5. Open questions (carried, non-blocking)

1. Win-probability presentation: exact stats method (simple Bayesian beta-binomial is the lean candidate) + our suppression floor. Decide at 4.2 with a worked example in the PR.
2. `held_out` as a `journey_states.status` vs a context tag — status is more queryable, but touches every status-enum consumer. Decide at 4.1.
3. ~~Does `sms_sends` need `campaign_id` now or at seam?~~ ANSWERED at 1.1: campaign steps are `send | wait` only (`packages/core/src/types/campaign.ts`) — no SMS steps exist today, so `sms_sends.campaign_id` waits for campaigns phase 2 (channel steps).
4. Milestone sugar: `kind: "milestone"` on defineConversion vs docs-only convention. Lean says convention first (decision rule: build the field only if Studio grouping needs it).
5. Backfill ergonomics: CLI-only vs also an admin endpoint. CLI-first matches the house pattern (Studio observes, code acts).
