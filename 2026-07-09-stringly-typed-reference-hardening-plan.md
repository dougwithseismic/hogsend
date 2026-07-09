# Stringly-typed reference hardening — plan

**Date:** 2026-07-09
**Status:** template-key fix DONE (committed separately); everything below is TODO.

## Why this exists

We shipped the activation journey broken because a journey could reference an
email template that **doesn't exist** and only fail when a real send ran (it used
`activation/…` slash-keys the registry never registered — it only had the
`activation-…` hyphen-keys). We fixed that class for **email template keys**:

- `SendEmailOptions.template` is now `TemplateName` (the registered-key union), not `string` → bad key = **compile error** at every send site.
- `Templates` constant now `satisfies Record<string, TemplateName>` → compile error at the source of truth.
- `getTemplate`/`getTemplateDefinition`/`getPreviewText` throw a loud, actionable error (via `Object.hasOwn`) → **runtime backstop** for dynamically-resolved keys.
- Tests lock both the compile guarantee and the runtime guard.

Then we audited the **rest of the codebase** for the same disease: a string that
resolves at runtime and can silently point at nothing. There are several, some
**worse** than the original (they fail *nowhere* — the journey just never fires).

## The governing principle (use this to pick the tool)

Guard a stringly-typed cross-reference by **whether its complete valid set is
materialized at build/boot**, not by whether it "feels" enumerable. Three tiers:

| Tier | The valid set is… | Tool | Rationale |
|---|---|---|---|
| **1** | materialized in this build **and** every ref must resolve here | **type + throw** (compile union / derived type + boot/runtime throw) | e.g. template keys, bucket refs, `ENABLED_JOURNEYS`, list `category`, provider `activeId` |
| **2** | materialized, but a ref may legitimately point **outside this process** | validate + **warn** | e.g. `history.journey({journeyId})`, destination `kind`, `ENABLED_*_PRESETS` |
| **3** | **not** materialized (arrives from external ingest/webhooks/PostHog) | soft-type `X \| (string & {})` + **boot typo-warn** + push the `Events` constant | e.g. all event names, `eventMirror` allow/deny, feature-flag keys |

The **corner to avoid:** applying tier-1 hard-typing to a tier-3 ref. A closed
`EventName` union would reject legitimately-external events (`stripe.*` from a
webhook, raw PostHog names) and make the type system lie. Events get a boot
*warning*, never a compile-closed union. Likewise, don't `throw` on a tier-2 ref
(e.g. an unknown `history.journey` id) — a multi-worker deploy legitimately
queries journeys not enabled in *this* process.

The template fix's **spirit** (author against a constant, validate at resolution,
fail loudly) generalizes to everything below. Its **mechanism** (closable union +
`satisfies` + throw) generalizes only to tier 1.

---

## Findings, ranked (all separate from the template PR)

### 🔴 HIGH

**1. Template `category` → list-id typo silently bypasses suppression** — `list-ids-and-category`, tier 1, **small**
- Sites: `packages/email/src/types.ts` `TemplateDefinition.category` (`string`); `apps/api/src/emails/registry.ts` `marketing/product-update` → `"product-updates"`; consumed in `packages/engine/src/lib/tracked.ts:checkSuppression`; the silent fallthrough is `packages/engine/src/lists/registry.ts` `isSubscribedByDefault` `?? true`.
- Failure: category typo (`"product-update"` vs list id `"product-updates"`) → `isSubscribed` returns opt-in default → the opt-in/consent email is delivered to **every** recipient, and real unsubscribes (`categories["product-updates"]=false`) are checked under the wrong key and ignored. **CAN-SPAM/GDPR grade.** tsc + boot both green today.
- Fix: in `createHogsendClient` after `buildListRegistry`, iterate the template registry; for each definition with `category` set, allowlist `{transactional, journey}` then require `listRegistry.has(category)`, else **throw** naming the bad category + known list ids. **Fail closed.** Also warn when a category points at a defined-but-*disabled* list (`ENABLED_LISTS` un-gates those). Harden the public `POST /v1/emails` `category` param too.

**2. `ENABLED_JOURNEYS` / journey-id typo silently kills a whole journey** — `journey-ids`, tier 1, **small**
- Sites: `packages/engine/src/env.ts` `ENABLED_JOURNEYS = z.string()`; `packages/engine/src/journeys/registry.ts` `parseEnabledFilter`/`buildJourneyRegistry`/`selectJourneyTasks` (`enabled.has(journey.meta.id)` — unknown id silently dropped); `packages/core/src/registry/index.ts` `JourneyRegistry.register` (`Map.set` = silent last-wins on dup id); `ctx.history.journey({journeyId})` in `packages/engine/src/journeys/journey-context.ts`.
- Failure: `ENABLED_JOURNEYS="welcom-series,..."` (typo) → journey never registered, task never listens, **no boot error** (only a generic `journeys: [...]` info line). `history.journey({journeyId:"onbaording"})` → `{completed:false,...}`, indistinguishable from "never entered" → wrong branch.
- Fix: in `buildJourneyRegistry`/`selectJourneyTasks` the full valid set is `journeys.map(j=>j.meta.id)` — diff the enabled Set against it and **throw** with a did-you-mean. Mirror in `container.ts` + `worker.ts`. Add a **duplicate-id throw** in `JourneyRegistry.register` (buckets already throw on reaction-id collision). For `history.journey`, **warn** not throw (tier 2 — a valid use queries a journey not enabled here).

**3. Event-name typo (`trigger`/`exitOn`/`waitForEvent`/`hasEvent`) — silent, worst of all** — `event-names`, tier 3, **medium**
- Sites: `packages/core/src/types/journey.ts` (`trigger.event`, `exitOn[].event`), `packages/core/src/types/journey-context.ts` (`WaitForEventOptions`/`HasEventOptions`/`TriggerOptions`/`RecentEventsOptions` `.event`) — all `string`; `journeyMetaSchema` = `z.string().min(1)`; consumed by `onEvents` (Hatchet routing) + `checkExits` (`!==` match) + `waitForEvent` (CEL).
- Failure: `trigger:{event:"user.craeted"}` compiles, registers under the typo, **never fires** — no error at boot/ingest/ever. `exitOn:[{event:"subscription.creaetd"}]` → user never exits → keeps receiving the series (wrong sends). `waitForEvent`/`hasEvent` typo → always the wrong branch. **Silenter than the template bug we fixed.**
- Fix: do **not** hard-type. (a) Soft-widen the event fields to `EventName | (string & {})` for autocomplete off the `Events` constant with zero false errors. (b) Add a boot pass over `JourneyRegistry.triggerIndex` + bucket `collectEventNames` (+ lifecycle `journey:completed/failed`) building the **produced** set vs the **consumed** set (`exitOn`, `eventMirror.allow/deny`), and **warn** only on near-misses (edit-distance 1) and — if the consumer passes its `Events` constant — any trigger/exitOn string absent from it. Explicitly **no** unconditional "trigger has no producer" warning (false-positives on every external trigger).

### 🟡 MEDIUM

**4. `ANALYTICS_PROVIDER` env typo silently disables analytics** — `connector-…-ids`, tier 1, **small** *(cheapest high-value fix)*
- Site: `packages/engine/src/container.ts` (~631) — the analytics throw is gated only on the *code* option (`analyticsGroup.defaultProvider`); an env typo (`ANALYTICS_PROVIDER=posthogg`) resolves to `undefined` and silently disables analytics (kills tz person-reads + event mirror). `EMAIL_PROVIDER` (~469) **throws** for the identical typo.
- Fix: add the symmetric guard on the env-selected `activeId`.

**5. Destination `kind` unknown → silent fallback signs w/ empty secret + POSTs** — `connector-…-ids`, tier 2, **medium**
- Sites: `packages/engine/src/workflows/deliver-webhook.ts` (~181) `get(kind) ?? webhookDestination`; contradicts the DLQ promise in `packages/engine/src/destinations/presets/index.ts`; admin `kindEnum` (`routes/admin/webhooks.ts`) accepts presets regardless of `ENABLED_DESTINATION_PRESETS`.
- Fix: DLQ (`adapterFailed`) an unknown non-`webhook` kind per the documented contract (or keep the fallback but boot-validate + loud-warn); reconcile the two contradicting docstrings; boot-warn `ENABLED_DESTINATION_PRESETS`/`ENABLED_WEBHOOK_PRESETS` csv typos; make admin `kindEnum` registry-aware (accept registered `defineDestination` kinds).

**6. Journey-id typed refs (DX)** — `journey-ids`, tier 1/2, **medium**
- Make `defineJourney<const Id>` → `DefinedJourney<Id>` carry a literal `readonly id: Id` (mirror `DefinedBucket<Id>.entered/left`) so `ctx.history.journey({journeyId: welcomeJourney.id})` and cross-journey refs are compile-checked. Optional consumer `JourneyId` union (the `BucketId` union is precedent). Do after #2.

### 🟢 LOW

**7. Finish deprecating the hand-maintained `BucketId` union + `bucketEntered`/`bucketLeft`** — `bucket-ids`, **small**
- The derived `DefinedBucket<Id>.entered/left` refs (`packages/engine/src/buckets/define-bucket.ts`) are *stronger* than any hand union (a typo is structurally impossible). Push consumers fully onto them; remove the deprecated `BucketId` union in `apps/api/src/journeys/constants/buckets.ts` (the only residual drift surface). Add a boot **warn** in `buildBucketRegistry` scanning journey `trigger`/`exitOn` for `^bucket:(entered|left):(.+)$` and checking the id against `bucketRegistry.getAll()` (a well-typed ref to an unregistered/disabled bucket silently never fires). The forward-only matcher already exists in `routes/admin/buckets.ts` `feedsMap` — lift it into boot.

**8. `eventMirror` allow/deny open-world typo** — `misc`, tier 3, folds into #3
- `container.ts` (~679) allow/deny lists matched at `ingestion.ts` `shouldMirrorEvent` (exact `includes()`); a typo silently drops an event from the PostHog mirror. Opt-in, default-off, observability-only. Fold the typo-warn into the #3 boot pass.

**Confirmed clean:** the template-key class is fully cured (every static + dynamic send path is typed or write-time-validated + backstopped by the loud `requireDefinition` guard). Inbound webhook-source / connector / email-provider-webhook ids are already guarded (404 / boot-throw). `sourceBucketId` is engine-derived (not consumer-authored) — not a gap.

---

## Recommended sequencing

1. **PR A — "boot-validate materialized config ids" (tier-1 throws, all small):** #4 `ANALYTICS_PROVIDER` symmetric throw + #2 `ENABLED_JOURNEYS` boot-throw + duplicate-journey-id throw + #1 list-`category` boot-validate. One tight engine-line PR in the same loud-guard spirit as the template fix. Highest value-per-line, closes the two compliance/blast-radius silent bugs.
2. **PR B — open-world event boot typo-warn** (#3 + #8) + soft-widen event field types.
3. **PR C — destination `kind` DLQ + preset-csv warns** (#5).
4. **PR D — journey-id typed refs** (#6) and **finish bucket deprecation + boot-warn** (#7).

Each is engine-line → its own changeset + release (see RELEASING / release-check).
Keep all of them **out** of the template PR.
