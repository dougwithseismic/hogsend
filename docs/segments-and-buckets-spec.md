# Buckets — Implementation Spec

> Buckets (also known as "segments" — for discoverability only; we lead with
> **Buckets** everywhere, see Section 2.5 for the deliberate naming).

Status: LOCKED design. This document is the implementation contract for
Hogsend's first-class **Buckets** primitive (a.k.a. "segments", discoverability
synonym only). An implementer should be able to follow it without guessing. Everything here is **additive** — no breaking
changes to `apps/api`, the engine factories, or consumer-facing types.

Constraints (carried from the directives, mirroring
`docs/scheduling-and-frequency-spec.md`):

- No `git commit` / `git push` (the lead handles git).
- No Supabase commands. Migrations are **generated as files**, not applied.
- Add deps with `pnpm add <pkg>@latest --filter <workspace>` — never hand-edit
  version numbers into a `package.json`.
- Biome style: 2-space indent, double quotes, semicolons, 80-col. Engine is ESM
  with `.js` extensions on relative imports. Node 22 target.
- Buckets are **code-first** (`defineBucket()` in the consumer's `src/buckets/`).
  Studio is **observe-not-author**. There is no visual bucket builder, ever.

---

## 1. Summary & goals

Buckets are named, real-time, code-defined groups of users — a peer primitive to
journeys. A user **joins** a bucket the moment their data satisfies the bucket's
criteria and **leaves** when it stops. Each transition fires a first-class event
(`bucket:entered` / `bucket:left`) through the existing ingestion spine, so **a
bucket join/leave can directly trigger a journey** (a journey's `trigger.event`
binds to `bucket:entered:<id>` via Hatchet's `onEvents` routing, exactly like any
other event). This closes the gap PostHog cannot serve today — sub-hour,
membership-change-as-a-trigger — while staying inside the existing
"PostHog detects, Hogsend acts" boundary by computing buckets off Hogsend's
**own** `userEvents` stream and reusing the existing `@hogsend/core` condition
engine. The chosen architecture is the **Hybrid (Approach B)** judged winner:
real-time inclusion/exclusion inside `ingestEvent()` plus an engine-owned Hatchet
**cron reconciliation** for time-based leaves that no event will ever signal,
hardened with three grafts from Approach A (a persisted `expiresAt` epoch, an
opt-in per-user fast-expiry durable timer, and a mandatory `bucket:` recursion
guard) and one from Approach C (journeys auto-exit via `exitOn: [bucket:left]`).

Goals:

1. `defineBucket({ meta })` is authored exactly like `defineJourney`, registered
   through the same client/worker wiring.
2. Membership is **materialized** (a `bucket_memberships` row), so transitions are
   diffable and idempotent — not recomputed on read.
3. Join/leave fire **only on transition** (never per evaluation, never for stable
   members) and route to journeys with **zero engine changes** to the journey
   side.
4. Time-based / absence buckets ("active in last 7 days") expire members
   correctly even with no inbound event.
5. Observe-only Studio surface: size, enter/leave over time, which journeys a
   bucket feeds, enable/disable. No authoring.

---

## 2. Philosophy & boundary reconciliation

### 2.1 An explicit, owned boundary revision (for Doug to ratify)

`docs/posthog-community-insights.md` ("Architectural Boundary — Resolved")
literally assigns **cohort computation AND inactivity/absence detection to
PostHog**, and says Hogsend should *not* replicate the PostHog event stream, poll
for inactivity, or compute cohorts. **This spec revises that boundary for the
real-time slice — and names the revision openly rather than smuggling it in as
"the research already resolved."** (Mirroring how `docs/boundary-revision-
proposal.md` states plainly when it walks back an earlier line.)

The revision, stated plainly:

> Hogsend computes membership **off its own ingested `userEvents` stream in real
> time** (event-driven joins + sub-hour reconciled leaves), regardless of window
> length. PostHog keeps (a) batch analytics cohorts that scan PostHog's own event
> store Hogsend never ingested, and (b) any detection over events Hogsend does not
> ingest, and (c) anything a team would rather author once in PostHog's cohort UI.

This is a **real boundary change**, listed in Open Questions (Section 15) for
ratification, and `docs/posthog-community-insights.md`'s "Resolved" section should
be updated to point at this revision so the two docs do not silently disagree.

### 2.2 The boundary is REAL-TIME vs BATCH recompute — NOT window duration

The earlier framing (now removed) scoped Hogsend's absence buckets to "short,
sub-24h windows." **That line was wrong and the spec's own flagship examples
violated it** (`went-dormant` uses `days(7)` = 168h; `power-users` uses `days(30)`
= 720h; the entire Section 7 walkthrough is built on the 7-day bucket). The
correct, defensible distinction is **how membership is recomputed, not how long
the window is**:

- **Hogsend owns** event-driven + sub-hour-reconciled membership computed off its
  **own** `userEvents` stream, using its **own** `evaluateCondition()` engine —
  at **any** window length. It never mirrors PostHog's event store and never polls
  PostHog. The gap it fills is PostHog's **~24h batch recompute** of dynamic
  cohorts (behavioral cohorts also error in real-time CDP destinations) and the
  absence of a **native cohort-membership-change webhook** (PostHog issue #18083,
  still open). Buckets give sub-second joins and membership-change-as-a-trigger.
- **PostHog owns** (a) cohorts that must scan PostHog's analytics event store
  Hogsend never ingested, and (b) any detection over events Hogsend does not
  ingest, and (c) anything authored once in PostHog's cohort UI.

The `days(7)` / `days(30)` examples are kept, now consistent with the corrected
rule. If a duration cap is ever wanted, it is a **documented operational
guardrail** (reconcile cost scales with `active_members × window` — see Section
13), **not** a positioning boundary.

### 2.3 Buckets COMPLEMENT the existing PostHog-webhook bridge (they do not replace it)

`docs/posthog-community-insights.md` ("Inactivity pattern that works TODAY") and
its PostHog Webhook Adapter (Feature Decision #1) already establish a sanctioned
path: **PostHog cohort → batch trigger → webhook into `/v1` ingest**. Buckets do
not compete with or replace it — they **complement** it. Use:

- **PostHog cohort → batch webhook → `/v1` ingest** for slow/analytics-defined
  audiences and anything keyed on events Hogsend does not ingest. A
  PostHog-cohort webhook can still fire a journey directly, **with no bucket
  involved**.
- **Buckets** for real-time, sub-hour membership computed off Hogsend's own event
  stream, where membership-change-as-a-trigger and `exitOn: [bucket:left]`
  auto-exit are the point.

### 2.4 Anti-CDP invariant (non-goal, with teeth)

Once you ship (a) a materialized membership table, (b) entered/exited transition
events, and (c) an arbitrary condition DSL, you have the core of Segment
Audiences. The ONLY thing that keeps Hogsend from BEING a CDP is the deliberate
refusal to add destination connectors — so this spec states it as a design
constraint, not a one-line aside (mirroring `competitive-positioning.md`
"Strategic non-goals"):

> **Invariant.** Buckets emit events into Hogsend's **own** journey system ONLY.
> The engine ships **exactly one** membership sync target: PostHog
> person-property `$set`/`$unset` (off by default, Section 12). Any other
> destination (Braze/HubSpot/Segment/etc.) is reached the **same way journeys
> reach any destination today** — a journey triggered on `bucket:entered:<id>`
> calling `ctx.webhook` or a user-written function (the documented plugin
> pattern) — **NOT** via an engine-owned sync. **Adding a `destinationSync` field
> to `BucketMeta` is forbidden.** First-class destination connectors would turn
> Hogsend into a generic CDP competing with Customer.io/Segment; they are an
> explicit non-goal.

### 2.5 Optional, off-by-default sync-back to PostHog

On join/leave, Hogsend MAY mirror membership to a boolean PostHog person property
`hogsend_bucket_<id>` via the existing `plugin-posthog` capture (Section 12). A
PostHog cohort built on that property is *person-property-only*, which PostHog
**inlines and evaluates in real time** in CDP destinations and feature flags. The
honest framing (no overclaim): **"Buckets give PostHog cohorts a real-time-
evaluable membership signal PostHog cannot compute itself."** The `$set` itself is
**not** end-to-end real-time — it is bounded by Hogsend's detection latency
(event-driven: sub-second; absence/time-based: bounded by the reconcile cadence),
then PostHog ingestion lag, then person-property propagation. The sync is a **no-op
without `POSTHOG_API_KEY`** (so it silently does nothing in self-host setups that
omit PostHog — documented, not broken).

> **Naming, deliberately.** We call them **Buckets**, not Segments — they are a
> real-time orchestration primitive for journeys, not a CDP audience-sync surface.
> "Segment" is the brand of the generic CDP this product is positioned against.
> The title/glossary keep "segment" only as a one-line discoverability synonym.

This honors the code-first / anti-CDP wedge: definitions live in code, Studio is
observe-only, and the only blessed external sync is back to PostHog.

---

## 3. Concepts & glossary

| Term | Meaning |
| --- | --- |
| **Bucket** | A named, code-defined predicate over a user's data. The peer of a journey. Defined with `defineBucket()`. |
| **Membership** | The materialized fact that a user is currently in a bucket — a `bucket_memberships` row with `status = "active"`. |
| **Criteria** | The membership predicate: a `ConditionEval` tree from `@hogsend/core` (property / event / email_engagement / composite). |
| **Enter / join** | A transition from non-member → member. Emits `bucket:entered:<id>` (and the generic `bucket:entered` only if a generic-bound journey exists — Section 8.5), gated by `reentry`. |
| **Leave / exit** | A transition from member → non-member. Emits `bucket:left:<id>` (generic as above), via a compare-and-swap UPDATE. |
| **Dynamic bucket** | `kind:"dynamic"` (default). Membership auto-recomputed from `criteria`. Two paths maintain it: real-time on ingest + cron reconcile for time windows. |
| **Static / manual bucket** | `kind:"manual"`. Membership mutated only by explicit API/import (no `criteria`). The escape hatch. Phase 4; the `kind` discriminator ships in Phase 1 for forward-compat. |
| **Time-based bucket** | A bucket whose criteria contain an `EventCondition.within` rolling window, so a clock change (not an event) can flip membership. Swept by the cron. |
| **Reconcile** | The engine-owned cron pass that recomputes time-based buckets and emits absence leaves (set-based, per criterion shape). |
| **Backfill / re-eval** | The chunked Hatchet job that materializes initial membership on first definition (no live joins) or re-evaluates members on a criteria change (leaves emit, joins don't). Status tracked like `import_jobs`. |

---

## 4. The `defineBucket()` API

`defineBucket` lives in `@hogsend/engine` (`packages/engine/src/buckets/define-bucket.ts`),
mirroring `defineJourney` and `defineWebhookSource` — the engine owns any
primitive that participates in runtime machinery. The **pure** `BucketMeta` type,
its Zod schema, and the `BucketRegistry` class live in `@hogsend/core`, mirroring
`JourneyMeta` / `journeyMetaSchema` / `JourneyRegistry`. Both are re-exported from
`@hogsend/engine` so consumers import everything from one place.

Unlike `defineJourney`, a bucket has **no `run` function** — it is purely
declarative (criteria only). This is the one place the API is *simpler* than a
journey.

### 4.1 `BucketMeta` (in `@hogsend/core`, mirrors `packages/core/src/types/journey.ts`)

```ts
// packages/core/src/types/bucket.ts
import type { DurationObject } from "../duration.js";
import type { ConditionEval } from "./conditions.js";

export interface BucketMeta {
  id: string;
  name: string;
  description?: string;
  /** Static load-time flag (guard #1), mirrors JourneyMeta.enabled. */
  enabled: boolean;

  /**
   * Discriminator, declared NOW for forward-compat even though "manual" ships in
   * Phase 4. "dynamic" (default) = membership auto-recomputed from `criteria`;
   * "manual" = membership mutated only by explicit API/import, NO criteria,
   * skipped by checkBucketMembership and the reconcile cron (early-continue, the
   * Laudspeaker pattern). Declaring it up front keeps Phase 4 genuinely additive
   * — no breaking change to BucketMeta later. Default "dynamic".
   */
  kind?: "dynamic" | "manual";

  /**
   * Membership predicate — the existing 4-type condition engine
   * (packages/core/src/conditions/evaluate.ts). Inclusion AND exclusion come
   * for free via neq / not_exists / not_opened and event check:"not_exists".
   * REQUIRED for kind:"dynamic" (omit/empty for kind:"manual"). Dynamic buckets
   * MUST contain at least one positive condition (validated; pure-negation
   * buckets are degenerate/unbounded — the Customer.io rule). The
   * at-least-one-positive refine applies to dynamic buckets only.
   * NOTE: criteria MUST NOT reference a reserved `bucket:*` event name in any
   * EventCondition.eventName (rejected at registration — see 4.2), so transition
   * rows can never satisfy a bucket predicate.
   */
  criteria?: ConditionEval;

  /**
   * Re-entry policy for EMITTED join events (maps onto checkEntryLimit
   * semantics). "once" = emit bucket:entered once ever; "once_per_period" =
   * re-emit only after a prior leave + period elapses; "unlimited" = always.
   * Default "unlimited".
   */
  reentry?: "once" | "once_per_period" | "unlimited";
  reentryPeriod?: DurationObject;

  /**
   * Anti-flap: suppress bucket:left until membership has existed at least this
   * long (debounce). Guards journeys from re-enroll spam on oscillation.
   */
  minDwell?: DurationObject;

  /**
   * Reconciliation knobs.
   * timeBased: criteria contain an event `within` window a clock can expire —
   *   the ONLY kind the cron sweep touches (candidate narrowing). Inferred from
   *   a criteria walk if omitted; an explicit value overrides.
   * reconcileEvery: advisory cadence surfaced in Studio (the single engine-wide
   *   cron sweeps all time-based buckets; per-bucket cadence is informational).
   * reconcileJoins: also re-evaluate JOINS in the sweep (default false — the
   *   real-time path already catches joins on event arrival; keep the sweep
   *   O(active members)).
   * fastExpiry: opt-in per-user durable timer for sub-second absence-leave on
   *   latency-critical buckets (Approach A graft). The cron remains the
   *   authoritative backstop. Default false.
   */
  timeBased?: boolean;
  reconcileEvery?: DurationObject;
  reconcileJoins?: boolean;
  fastExpiry?: boolean;

  /**
   * PostHog person-property sync (Section 12). Off by default. When set, on
   * join/leave the engine $set/$unset a boolean person property keyed by
   * `propertyKey` (default `hogsend_bucket_<id>`).
   */
  syncToPostHog?: boolean;
  postHogPropertyKey?: string;
}
```

**No `suppress` field (deliberate).** Unlike `JourneyMeta`, `BucketMeta` has no
`suppress` knob. (`JourneyMeta.suppress` is itself currently a NO-OP in the
engine — carried in metadata/admin serialization at `journeys.ts:153,486` but
never read by any enrollment guard — so nothing is lost.) Bucket anti-flap is
handled by two distinct mechanisms: `minDwell` (debounce-before-leave) and
`reentry`/`reentryPeriod` (re-emit cooldown). These are NOT the journey
post-completion suppression window; bucket transitions do not participate in any
journey suppression window. An author migrating from journeys should map
"don't re-fire too soon" onto `reentry`, not a missing `suppress`.

### 4.2 `bucketMetaSchema` (Zod, mirrors `packages/core/src/schemas/journey.schema.ts`)

`BucketRegistry.register()` runs `bucketMetaSchema.parse(meta)` before storing,
exactly as `JourneyRegistry.register()` runs `journeyMetaSchema.parse()`
(`packages/core/src/registry/index.ts:9`). The schema reuses the existing
`conditionEvalSchema` discriminated union for `criteria`. Its `.superRefine`
enforces four rules:

1. **At-least-one-positive-condition** (dynamic buckets only) — walk the criteria
   tree and reject trees whose leaves are all negative
   (`neq`/`not_exists`/`not_opened`/`not_clicked` and `event check:"not_exists"`).
   **Exception (load-bearing):** an `event` `not_exists` leaf that carries a
   `within` window is a *time-bounded behavioral absence* ("did NOT do X in the
   last N") — the canonical dormancy/churn predicate the whole cron-reconcile
   leave path exists to serve (e.g. the `went-dormant` example in §4.4). It is
   bounded by its window, so it counts as a legitimate anchor and does NOT make a
   tree "all negative". Only an *unbounded* absence (`not_exists` with no
   `within`) is degenerate. Without this exception the flagship `went-dormant`
   bucket fails registration and the API refuses to boot.
2. **Reserved-prefix rejection** — reject if any `EventCondition.eventName` in the
   tree starts with `bucket:`. Transition events are reserved internal names;
   allowing a criterion to count them would let `bucket:*` rows (which ARE written
   to `userEvents`, Section 8.5) satisfy a bucket predicate. This is enforceable at
   registration (it inspects only the static criteria tree).
3. **email_engagement forbidden in v1** — reject any `EmailEngagementCondition`
   anywhere in the tree, with a clear error. This is the HONEST, enforceable form
   of the v1 restriction: at registration the engine has only `BucketMeta` (no
   users), so it CANNOT validate `email === externalId` (a per-user runtime fact).
   See Section 5 for why the alternative (a distinct `email` field on
   `ConditionContext`) is deferred.
4. **kind/criteria coherence** — `kind:"dynamic"` (or omitted) REQUIRES a
   non-empty `criteria`; `kind:"manual"` REQUIRES `criteria` absent. Manual buckets
   skip rules 1–3.

### 4.3 `defineBucket` + `DefinedBucket` (in `@hogsend/engine`)

```ts
// packages/engine/src/buckets/define-bucket.ts
import type { BucketMeta } from "@hogsend/core/types";

export interface DefinedBucket {
  meta: BucketMeta;
  /**
   * The only task a bucket ever holds is the opt-in per-user fast-expiry timer,
   * which is a DURABLE task (it `ctx.sleepFor`s — Section 6.5), so the type
   * MUST be the durableTask return type, mirroring
   * `DefinedJourney.task = ReturnType<typeof hatchet.durableTask>`
   * (define-journey.ts:34) — NOT `hatchet.task`. The common case is
   * declarative-only (no task), like webhookSources; the engine-wide
   * bucketReconcileTask handles time-based leaves regardless.
   */
  task?: ReturnType<typeof import("../lib/hatchet.js").hatchet.durableTask>;
}

export function defineBucket(options: { meta: BucketMeta }): DefinedBucket {
  // bucketMetaSchema.parse happens at BucketRegistry.register (the journey
  // precedent). defineBucket stays a PURE passthrough — identical in shape to
  // defineWebhookSource (define-webhook-source.ts:30-34) — and does NOT branch
  // on meta or construct any task. This keeps the three primitives consistent
  // and avoids building a Hatchet durableTask at module-load before validation
  // has run. The fast-expiry durableTask is synthesized later, at worker build,
  // by selectBucketTasks(buckets, enabled) reading meta.fastExpiry (Section 9.4)
  // — that is the single place a bucket's task is constructed, AFTER the registry
  // has validated the meta.
  return { meta: options.meta };
}
```

### 4.4 Realistic examples (consumer `apps/api/src/buckets/`)

```ts
// apps/api/src/buckets/power-users.ts
import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Behavioral inclusion — fired in 10+ times in the last 30 days. Time-based
// (rolling window) → swept by the reconcile cron for the absence leave.
export const powerUsers = defineBucket({
  meta: {
    id: "power-users",
    name: "Power users",
    description: "Performed a key action 10+ times in the last 30 days.",
    enabled: true,
    timeBased: true,
    reentry: "once_per_period",
    reentryPeriod: { hours: 24 * 7 },
    criteria: {
      type: "event",
      eventName: Events.KEY_ACTION,
      check: "count",
      operator: "gte",
      value: 10,
      within: { hours: 24 * 30 }, // days(30)
    },
  },
});
```

```ts
// apps/api/src/buckets/trial-expiring-soon.ts
import { defineBucket } from "@hogsend/engine";

// Property inclusion + exclusion — on trial, plan not yet upgraded. Pure
// property predicates → in-memory, real-time only, NOT time-based.
export const trialExpiringSoon = defineBucket({
  meta: {
    id: "trial-expiring-soon",
    name: "Trial expiring soon",
    enabled: true,
    reentry: "once",
    criteria: {
      type: "composite",
      operator: "and",
      conditions: [
        { type: "property", property: "plan", operator: "eq", value: "trial" },
        {
          type: "property",
          property: "trial_days_left",
          operator: "lte",
          value: 3,
        },
        // exclusion: not already converted
        { type: "property", property: "converted", operator: "neq", value: true },
      ],
    },
  },
});
```

```ts
// apps/api/src/buckets/went-dormant.ts
import { defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Absence — did NOT do app.active in the last 7 days. The canonical time-based
// leave: no event will ever signal it; the cron sweep owns it. fastExpiry on for
// near-instant winback eligibility.
export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: {
      type: "event",
      eventName: Events.APP_ACTIVE,
      check: "not_exists",
      within: { hours: 24 * 7 }, // days(7)
    },
  },
});
```

### 4.5 Emitted event-naming convention

Every transition emits **two** events through `ingestEvent()`:

1. **A generic event** — `bucket:entered` / `bucket:left` — carrying flat scalar
   properties `{ bucketId, bucketName, userId, transition, source }`. Useful for
   a single journey/handler that reacts to *all* bucket transitions and switches
   on `bucketId`.
2. **A per-bucket alias** — `bucket:entered:<id>` / `bucket:left:<id>` (e.g.
   `bucket:entered:power-users`) — with the same properties. This is the
   **recommended binding** for journeys.

**Justification.** Hatchet routes by **exact event-name match** on `onEvents`
(`hatchet.events.push(event.event, ...)` at `ingestion.ts:73`; journey tasks
declare `onEvents: [meta.trigger.event]` at `define-journey.ts:45`). A journey
binding to the *generic* `bucket:entered` would be woken for **every** bucket's
joins and must then filter with `trigger.where` on `bucketId`
(`evaluatePropertyConditions`, `define-journey.ts:68-77`). That works but wakes
the durable task on irrelevant events. The **aliased** `bucket:entered:<id>`
lets a journey bind narrowly — Hatchet only routes that bucket's joins to it,
zero wasted task starts. Properties are kept **flat scalars** because the Hatchet
push strips non-primitives (`ingestion.ts:62-70`).

> **Cost warning — the two bindings are NOT ergonomically equivalent.** Binding a
> journey to the **generic** `bucket:entered` wakes that journey's durable task on
> **every** bucket's transitions; it then runs guards, evaluates `trigger.where`
> (`define-journey.ts:68-77`), and returns `skipped` for non-matching `bucketId` —
> it does NOT create state, but it DOES consume a Hatchet run per irrelevant
> transition. For an app with many buckets this is a real, invisible-from-the-API
> cost. The **aliased** `bucket:entered:<id>` is therefore the **default** for
> per-bucket reactions; reserve the generic form for a deliberate all-buckets
> handler. (This is also why the default emission is **aliased-only** — Section 8.5
> / Open Question 3 — with the generic emitted only when a generic-bound journey
> exists.)

Consumer constants (Section 9) provide both forms. The alias helpers are
**id-validated** — a typo like `bucketEntered("went-dorment")` must fail to
type-check, matching the DX bar set by `Events`/`Templates` (`as const` unions +
the `templates.d.ts` module augmentation). They derive a `BucketId` union from
the consumer's own `buckets` array so the safety net survives where the two
primitives compose (bucket → journey):

```ts
export const Events = {
  // ...existing...
  BUCKET_ENTERED: "bucket:entered",
  BUCKET_LEFT: "bucket:left",
} as const;

// Derive the union of registered bucket ids from the consumer's buckets array.
// (Defined in apps/api/src/buckets/index.ts; re-exported into constants.)
import { buckets } from "../../buckets/index.js";
export type BucketId = (typeof buckets)[number]["meta"]["id"];

// Narrow-alias helpers — ONLY accept a registered BucketId, so a typo is a
// compile error rather than a silently-never-firing trigger:
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;
export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;
```

The chosen approach is the array-derived union (cheapest, no extra augmentation
machinery, and `(typeof buckets)[number]["meta"]["id"]` literal-infers because
`defineBucket` returns `{ meta }` structurally). A `templates.d.ts`-style global
augmentation is an option if cross-file id registration is later wanted, but the
array-derived union is sufficient for v1 and is documented in the Section 9.6
wiring checklist so the union stays in sync. This is a strict requirement, not a
nicety: `JourneyMeta.trigger.event` is typed `string`, so without the union an
unbound/typo alias compiles and never fires.

---

## 5. Membership criteria

Criteria are the existing `@hogsend/core` `ConditionEval` union — no new
condition language (`packages/core/src/types/conditions.ts`):

```ts
export type ConditionEval =
  | PropertyCondition       // in-memory: reads ctx.journeyContext[property]
  | EventCondition          // DB: count(*) over userEvents (+ within window)
  | EmailEngagementCondition// DB: latest emailSends row for toEmail+templateKey
  | CompositeCondition;     // and/or over ConditionEval[] (recursive)
```

Evaluated by the single async entry point
`evaluateCondition({ condition, ctx })` (`packages/core/src/conditions/evaluate.ts:14`),
where `ctx: { db, userId, journeyContext }`.

- **Inclusion** — positive operators: `eq`/`gt`/`gte`/`contains`/`exists`;
  `event check:"exists"`; `email_engagement check:"opened"|"clicked"`.
- **Exclusion** — negative operators inline in the same tree (no separate
  exclusion list, matching Laudspeaker/Customer.io): `neq`/`not_exists`;
  `event check:"not_exists"`; `email_engagement check:"not_opened"|"not_clicked"`.
- **Behavioral "did X in last N days"** — `{ type:"event", eventName, check:"exists", within: days(N) }`.
- **Behavioral "did NOT do X in last N days"** — same with `check:"not_exists"`.
  This is the time-based / absence case the cron must own.
- **Count thresholds** — `{ type:"event", eventName, check:"count", operator:"gte", value:10, within: days(30) }`.
- **Composition** — arbitrarily nested `composite` AND/OR.

**Constraints carried into v1:**

- **email_engagement is flatly forbidden in bucket criteria in v1** —
  `bucketMetaSchema` rejects any `EmailEngagementCondition` at registration (the
  honest, enforceable form). The earlier "unless email === externalId, validated at
  registration" wording was **unenforceable**: `email_engagement` keys on
  `emailSends.toEmail` while `event` keys on `userEvents.userId =
  ConditionContext.userId = externalId`, and `email === externalId` is a per-USER
  runtime fact — at REGISTRATION the engine has only `BucketMeta` (no users), so it
  cannot validate it; there is also no single `ConditionContext` that carries both
  identifiers. Revisit by extending `ConditionContext` with a distinct `email`
  field populated by the bucket evaluator from the contact row (the only path that
  would make `email_engagement` correctly evaluable) — deferred past v1.
- **Buckets-of-buckets** (a criterion referencing another bucket's membership)
  is **deferred** — it needs a new `ConditionEval` variant and topological
  ordering to avoid recursion. Not in v1.
- **Bucket membership as a journey/bucket enrollment or suppression condition**
  ("enroll only if user is/isn't in bucket Y", e.g. don't send winback to users
  already in the high-value bucket) is **also deferred** — it is broader than
  buckets-of-buckets and needs the same `in_bucket` / `not_in_bucket`
  `ConditionEval` variant. **v1 workaround:** mirror membership to a person/contact
  property (`syncToPostHog`, Section 12, or a contact-property write) and gate with
  an ordinary `PropertyCondition`. Acknowledged as a known v1 gap, not silent.
- **No absolute date ranges / "between"** — `within` is relative-to-now only
  (`Date.now() - durationToMs(within)`), inherited from the condition engine.

---

## 6. Evaluation engine (chosen architecture)

**Winner: Approach B (Hybrid)** — real-time inclusion/exclusion inside
`ingestEvent()` **plus** an engine-owned Hatchet **cron reconciliation** for
time-based leaves. **Grafts applied:**

- (A) Persist `expiresAt` on the membership row and an **opt-in per-user
  fast-expiry durable timer** (`meta.fastExpiry`) for sub-second absence-leave,
  with the cron as the authoritative backstop.
- (A) Make the reserved **`bucket:` prefix recursion guard** a first-class,
  tested invariant.
- (C) Journeys auto-exit on leave via `exitOn: [bucket:left:<id>]` — free,
  because bucket events route through `ingestEvent` into the existing
  `checkExits` path.
- **Not** adopted from C: the durable-task-per-bucket-per-event execution model
  (multiplies Hatchet runs by N for no correctness benefit over the additive
  in-ingest loop).

### 6.1 Real-time path — exact insertion point in `ingestEvent`

A new `checkBucketMembership()` call is added to
`packages/engine/src/lib/ingestion.ts`, structurally a sibling of the existing
`checkExits` (`ingestion.ts:105-162`). The current shape pushes to Hatchet,
checks exits, and upserts the contact **concurrently** in one `Promise.all`
(`ingestion.ts:72-94`). Bucket re-eval must NOT join that `Promise.all` because
`upsertContact` runs there and would leave merged contact props stale.

**Ordering rules (load-bearing):**

1. **Recursion guard first.** At the very top of `checkBucketMembership`, if
   `event.event.startsWith("bucket:")` → return immediately. `ingestEvent` has
   **no** built-in re-entry guard (the same reason `ctx.trigger` recurses freely
   at `journey-context.ts`), so this prefix guard is the thing that bounds
   recursion. Covered by a unit test asserting any `bucket:`-prefixed event
   short-circuits before the registry lookup. (Note this guard stops bucket
   re-evaluation only; transition rows are still written to `userEvents` / pushed
   to Hatchet / run through `checkExits` — see Section 8.5 + Open Question 3 for
   the row-growth implications.)
2. **The `userEvents` insert and the bucket count evaluation MUST run in the SAME
   transaction (or reuse the connection that performed the insert).** The spec
   places `checkBucketMembership` after the `userEvents` insert/idempotency
   short-circuit (`ingestion.ts:51-60`) so `event`-count criteria see the
   just-stored row — but that visibility is only guaranteed within one
   transaction/connection. The repo runs **TimescaleDB with no transaction
   pooler today**, so a plain post-insert read happens to work; if a
   transaction-mode pooler (pgbouncer) is ever introduced, the count query could
   run on a different backend before the insert commits and read `N-1`, **silently
   missing a threshold-crossing JOIN** that no later event re-triggers. To make
   this robust regardless of pooling, the spec mandates EITHER:
   - (preferred, no read-after-write dependency) compute the windowed count as
     `db_count + 1` for the current event **when `event.event === criterion
     .eventName`** and the event falls inside the window — so the just-fired event
     is counted arithmetically, not re-read; OR
   - run the insert + the candidate count queries inside one explicit transaction
     so the row is guaranteed visible.

   Document the connection-pooling assumption explicitly; this is a latent
   correctness bug the moment a pooler appears.
3. **Property predicates evaluate against MERGED contact state, not the raw event
   payload.** This is mandatory and is the common case (every property-based
   bucket). `evaluatePropertyCondition` reads `ctx.journeyContext[property]`
   (`property.ts:9`) and returns false for absent props on positive operators but
   **true** for `neq` against `undefined` (`property.ts:30-61`). A single inbound
   event almost never carries a contact's full `{ plan, trial_days_left,
   converted }` state — those live on the `contacts` row (cumulatively merged by
   `upsertContact`) or PostHog person props. Evaluating against the bare event
   payload therefore (i) fails positive checks whose key is absent → spurious
   non-membership → **spurious `bucket:left`**, and (ii) passes `neq` against
   `undefined` → exclusions silently never exclude, then **spurious re-join** when
   an event happens to carry the props. This is silent membership flapping driven
   by which props ride each event.

   **The fix:** before evaluating any candidate whose criteria contain a
   `PropertyCondition`, fetch the contact row and build
   `journeyContext = { ...contact.properties, ...event.properties }` (event
   overlays contact). Because `upsertContact` is fire-and-forget inside the
   ingestion `Promise.all` (`ingestion.ts:83-93`) and its failure is swallowed,
   the bucket eval MUST NOT depend on it having run — either `await upsertContact`
   *before* bucket eval, or (simpler, no ordering coupling) read the EXISTING
   `contacts` row and merge `{ ...existingContactProps, ...event.properties }`
   explicitly inside the candidate eval. Pure-event/count buckets (no
   `PropertyCondition`) skip the contact read entirely. One contact read per
   ingest that has at least one property-bearing candidate is the documented
   price of correct property buckets.

```ts
// packages/engine/src/lib/ingestion.ts (sketch — additive)
import { evaluateCondition } from "@hogsend/core";
import { getBucketRegistrySingleton } from "../buckets/registry-singleton.js";

// inside ingestEvent, AFTER the userEvents insert/idempotency short-circuit
// (after line 60) and BEFORE/alongside the existing Promise.all. `registry` is
// the JOURNEY registry — already a param of ingestEvent (ingestion.ts:28-34) —
// and MUST be threaded through so the recursive emit can call ingestEvent again.
// The BUCKET registry is read separately via getBucketRegistrySingleton().
const bucketTransitions = await checkBucketMembership({
  db,
  registry,            // journey registry, forwarded into the recursive emit
  hatchet,
  logger,
  event: {
    userId: event.userId,
    userEmail: event.userEmail,
    event: event.event,
    properties: event.properties,
  },
});
// checkBucketMembership emits bucket:entered/left itself via ingestEvent
// recursion (see 6.3), so callers ignore the return value EXCEPT in tests, where
// it returns the computed transition list so a unit test can assert
// enter/leave/no-op WITHOUT inspecting a live Hatchet (Section 14 Testing).
```

> **Signature consistency (DX).** `checkBucketMembership` takes the SAME `opts`
> object shape as `ingestEvent` (`{ db, registry, hatchet, logger, event }`) and
> forwards it into the recursive `ingestEvent` call in `emitBucket`. The journey
> `registry` flows in as a param; the bucket registry is fetched via
> `getBucketRegistrySingleton()` inside the function. The two registries are never
> conflated. (The earlier `checkBucketMembership(db, hatchet, logger, {...})`
> positional form omitted `registry` and could not have constructed the recursive
> `ingestEvent` call — fixed here.)

### 6.2 Candidate narrowing (cheap pre-filter)

`checkBucketMembership` must **not** re-evaluate every bucket per event. The
`BucketRegistry` (Section 9) carries **two** inverted indexes, both built by
walking each bucket's `criteria` tree at registration:

- `eventIndex: Map<eventName, BucketMeta[]>` from `collectEventNames(criteria)`
  (every `EventCondition.eventName`), mirroring `JourneyRegistry.triggerIndex`
  (`registry/index.ts:6`) and Laudspeaker's `containsEventNameWithValue` trick.
- `propertyIndex: Map<propertyName, BucketMeta[]>` from a NEW
  `collectPropertyNames(criteria)` walk (every `PropertyCondition.property`).

The candidate set for an ingested event is the UNION of:

```ts
const candidates = new Set<BucketMeta>([
  ...bucketRegistry.getByReferencedEvent(event.event),
  ...Object.keys(event.properties ?? {}).flatMap((k) =>
    bucketRegistry.getByReferencedProperty(k),
  ),
]);
```

- **Why a property index is mandatory.** The earlier design filed all
  property-only buckets under a single `"*"` key and claimed they "re-eval only
  when a relevant property is present" — but the registry has no event payload at
  registration time, so it cannot make that decision; in practice every
  property-only bucket would re-evaluate on EVERY ingested event, making the
  real-time path **O(property-only-bucket-count) = O(N)** for the common
  property-bucket case (directly invalidating the "independent of N" claim). With
  `propertyIndex`, a property-only bucket is a candidate only when the event
  payload actually carries one of its referenced properties.
- **Reserve `"*"` for degenerate buckets only** — those whose criteria reference
  neither a concrete event nor any property. The at-least-one-positive rule makes
  these rare; they pay on every event and should be discouraged.
- **`bucket_configs` is NOT read per-candidate-per-event.** Reading
  `db.query.bucketConfigs.findFirst` inline in `ingestEvent` — on the latency path
  of EVERY event from EVERY source (HTTP ingest, webhooks, tracking opens/clicks,
  `ctx.trigger`) — would add `K × M` point reads/sec purely for a rarely-changing
  kill switch (journeys avoid this by reading `journeyConfigs` once at the start of
  an already-async durable task). Instead, load the enabled-override map **once per
  process** (or with a short TTL cache, e.g. a few seconds) and consult the
  in-memory map in `checkBucketMembership`; invalidate it on the
  `PATCH /v1/admin/buckets/{id}` write path. The cache TTL is the documented upper
  bound on kill-switch propagation latency (acceptable; mirrors the
  `ENABLED_BUCKETS` restart asymmetry in Section 9.3). Skip a candidate whose
  effective `enabled` is false (runtime kill switch, mirroring
  `define-journey.ts:61-66`).
- For each surviving candidate, run
  `evaluateCondition({ condition: bucket.criteria, ctx: { db, userId, journeyContext } })`
  with the merged `journeyContext` from 6.1 rule #3.

> **Authoring guidance (composite ordering).** `composite.ts` awaits each
> sub-condition **serially**, so per-candidate latency is the SUM of its DB
> sub-conditions' round-trips (not parallel); AND short-circuits on the first
> false, OR does not short-circuit until a hit. Put cheap **in-memory
> `PropertyCondition`s FIRST** in an AND composite so a property mismatch
> short-circuits before any DB query runs. (A future optimization could parallelize
> independent sub-conditions; out of v1 scope.)

### 6.3 Enter/leave diffing + emission

For each candidate, compute `isMember` (eval result) vs `wasMember` (an
`active` `bucket_memberships` row), then diff — exactly the
`doInclude` vs `isMemberOf` pattern from Laudspeaker, structurally the
`checkExits` diff:

**The governing rule: emission is gated on WINNING the row mutation, never on a
separate idempotencyKey race.** Every `emitBucket` call is conditioned on the
`RETURNING` result of the atomic insert/update that produced the transition. The
loser of a concurrent race mutates zero rows and therefore never emits — so there
is no double-emit to dedup. The `idempotencyKey` is **defense-in-depth**, not the
primary mechanism.

```ts
const active = await db.query.bucketMemberships.findFirst({
  where: and(
    eq(bucketMemberships.userId, userId),
    eq(bucketMemberships.bucketId, bucket.id),
    eq(bucketMemberships.status, "active"),
    isNull(bucketMemberships.deletedAt),
  ),
});
const wasMember = !!active;
const isMember = await evaluateCondition({ condition: bucket.criteria, ctx });

if (!wasMember && isMember) {
  // JOIN — insert a FRESH active row, gated on the partial active unique index.
  // ON CONFLICT DO NOTHING means a concurrent emitter that already inserted the
  // active row makes THIS insert return zero rows → we do NOT emit.
  // (count(*) via the same idiom as core/conditions/event.ts:13.)
  const [{ priorCount }] = await db
    .select({ priorCount: sql<number>`count(*)::int` })
    .from(bucketMemberships)
    .where(and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucket.id),
    ));
  const inserted = await db
    .insert(bucketMemberships)
    .values({
      userId, userEmail, bucketId: bucket.id,
      status: "active", source: "event",
      entryCount: priorCount + 1,              // re-entry ordinal (Studio)
      expiresAt: computeExpiresAt(bucket, ctx), // null for non-time-based
    })
    .onConflictDoNothing() // targets uq_user_bucket_active (active partial index)
    .returning({ id: bucketMemberships.id });
  if (inserted.length === 1) {
    // membershipEpoch = the winning row's entryCount (read back / known here).
    // It is produced by THIS single winning mutation, so it is unambiguous and
    // identical to whatever any other producer would read off the row.
    const epoch = priorCount + 1;
    if (shouldEmitJoin(bucket, userId, priorCount, active /* prior rows */)) {
      await emitBucket("entered", bucket, userId, userEmail, epoch);
    }
    // The active row is written even when the EMIT is suppressed by reentry
    // (Studio size must reflect reality); only the bucket:entered ingestEvent
    // recursion is skipped. The epoch still advanced via the real insert, so a
    // later legitimate emit is not deduped against a suppressed one.
    if (bucket.fastExpiry) await armExpiryTimer(bucket, userId, epoch);
  }
} else if (wasMember && !isMember) {
  // LEAVE — minDwell DEFERS (does not drop) the leave; see below.
  if (withinMinDwell(active, bucket)) {
    await deferLeave(active, bucket); // schedule a re-check; never silently drop
    return;
  }
  // Compare-and-swap: only the emitter whose UPDATE actually flips the row emits.
  const left = await db
    .update(bucketMemberships)
    .set({ status: "left", leftAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(bucketMemberships.id, active.id),
      eq(bucketMemberships.status, "active"), // CAS guard
    ))
    .returning({ id: bucketMemberships.id, entryCount: bucketMemberships.entryCount });
  if (left.length === 1) {
    await emitBucket("left", bucket, userId, userEmail, left[0].entryCount);
  }
} // else no change → optionally bump lastEvaluatedAt; emit NOTHING
```

**`shouldEmitJoin` — the `reentry` gate (was a documented no-op; now real).**
`reentry`/`reentryPeriod` previously had NO implementation path — `emitBucket`
fired unconditionally and `checkEntryLimit` is journey-side (`enrollment-
guards.ts`, keyed on `journeyStates.createdAt`) and is never invoked by buckets.
A bucket-side gate is specified here, consulted on the JOIN transition only:

```ts
function shouldEmitJoin(bucket, userId, priorCount, priorRows): boolean {
  if (priorCount === 0) return true;          // first-ever join always emits
  switch (bucket.reentry ?? "unlimited") {
    case "unlimited":      return true;
    case "once":           return false;       // any prior membership → suppress
    case "once_per_period": {
      const lastLeftOrEntered = mostRecentTransitionTs(priorRows);
      return Date.now() - lastLeftOrEntered >= durationToMs(bucket.reentryPeriod);
    }
  }
}
```

- `once` → emit `bucket:entered` once **ever** (suppress if any prior membership
  row exists), mirroring `checkEntryLimit "once"`.
- `once_per_period` → suppress unless the most recent prior `leftAt`/`enteredAt` is
  older than `reentryPeriod`, mirroring the `createdAt`-cutoff logic.
- **Critically: suppressing the EMIT still writes the active membership row** (so
  Studio size reflects reality) and still **advances the epoch** via the real
  insert; only the `bucket:entered` `ingestEvent` recursion is skipped. If the
  epoch did not advance on a suppressed-but-real transition, a later legitimate
  emit could be deduped against it.
- This is the EMIT gate only; the journey it would trigger ALSO has its own
  `entryLimit`/`entryPeriod`. The two-layer interaction (bucket-side
  `reentry` + journey-side `entryLimit`) is documented in Section 13 so authors
  are not surprised by double-gating.

**`deferLeave` — minDwell must DEFER, never DROP (was: stuck-active members).**
The earlier `if (withinMinDwell) return;` suppressed the leave AND scheduled no
re-check — so a user who satisfied-then-stopped-satisfying inside the dwell window
and then went silent stayed `active` forever (the cron only sweeps `timeBased`
buckets; a pure-property bucket is not swept), and any journey expecting
`exitOn:[bucket:left]` never exited. Two allowed implementations:

- (a) Record a pending-leave marker — set `expiresAt = enteredAt + minDwell` — and
  **treat the bucket as `timeBased`** so the reconcile cron (or fastExpiry timer)
  re-checks after the dwell elapses and emits the leave via the CAS path; OR
- (b) Only honor `minDwell` on buckets that already have a sweep path (timeBased
  or fastExpiry), and **reject `minDwell` on pure-property buckets** at
  registration (they have no re-check path). Recommended default: (a), because it
  keeps `minDwell` usable on property buckets.

**`emitBucket` — recurses through `ingestEvent` (the `ctx.trigger` precedent),**
emitting **both** generic and aliased events (subject to Open Question 3, where
the recommendation is now **aliased-only by default** — see Section 13). Each
emitted event is persisted to `userEvents`, pushed to Hatchet (routing to
journeys), and run through `checkExits`:

```ts
async function emitBucket(kind, bucket, userId, userEmail, epoch) {
  const props = {
    bucketId: bucket.id, bucketName: bucket.name,
    userId, transition: kind, source: "event",
  };
  // epoch is the winning row's entryCount — passed in by the caller, READ from
  // the single winning mutation. All three producers (real-time, cron,
  // fast-expiry) read this same field off the same row, so they compute
  // byte-identical idempotencyKeys for the same transition (worked example below).
  await ingestEvent({ db, registry, hatchet, logger, event: {
    event: `bucket:${kind}:${bucket.id}`, userId, userEmail, properties: props,
    idempotencyKey: `bucket:${bucket.id}:${userId}:${kind}:${epoch}`,
  }});
  // Generic bucket:${kind} emitted ONLY if a generic-bound journey exists
  // (Open Question 3 / Section 13): default is aliased-only.
}
```

**Idempotency / no-double-emit — emission is gated on the atomic mutation; the
idempotencyKey is a second line of defense.** The earlier "three layers converge"
prose overstated the guarantee: it emitted AFTER the insert/update without checking
the mutation actually changed a row, and never defined how `membershipEpoch` was
computed deterministically across processes — so two concurrent emitters (ingest
tick + cron tick) could read the row at different instants, compute different
epochs, and BOTH emit (the unique index blocks the duplicate ROW, not the duplicate
EVENT). The corrected model:

1. **Emission gated on RETURNING** — JOIN emits only if `INSERT ... ON CONFLICT DO
   NOTHING RETURNING id` returned a row; LEAVE emits only if the CAS
   `UPDATE ... WHERE id=? AND status='active' RETURNING id` returned a row. The
   loser mutates zero rows and never emits. This is the **primary** guarantee.
2. **`membershipEpoch` is defined precisely and identically for all producers** —
   it is the membership row's `entryCount`, produced by the single winning JOIN
   insert (`priorCount + 1`) and read verbatim by the LEAVE / cron / fastExpiry
   paths off the same row. It is a monotonic per-(user,bucket) ordinal — NOT a
   timestamp (the earlier text conflated `expiresAt`-as-epoch with a counter).
   `expiresAt` is the fastExpiry **timer arming** value, a separate concern.
3. **Deterministic `idempotencyKey`** `bucket:${id}:${userId}:${kind}:${epoch}`
   rides the existing `user_events` dedup short-circuit (`ingestion.ts:37-53`,
   `onConflictDoNothing` on `user_events_idempotency_key_idx`) — defense-in-depth
   only.

**Worked example (concurrent ingest + cron tick, same JOIN).** Suppose `entryCount`
for `(u, b)` would become 3. Both producers attempt
`INSERT ... ON CONFLICT DO NOTHING RETURNING id`. Exactly one wins; its row has
`entryCount = 3`. Only the winner gets a returned row and emits
`bucket:entered:b` with `idempotencyKey = bucket:b:u:entered:3`. The loser's insert
returns zero rows → it never emits. Even if a bug caused the loser to also try to
emit, it would read the SAME `entryCount = 3` off the now-existing row → produce the
SAME idempotencyKey → the `user_events` dedup collapses it. No double-fire, no
double journey enrollment. (This is the concrete test Phase 2 requires.)

The in-step active-membership lookup remains a cheap pre-filter (mirrors the
journey active-state guard at `define-journey.ts:93-102`), but the **authoritative**
guard is the `RETURNING`-gated mutation, not the lookup.

### 6.4 Cron reconciliation — the time-based leave path

Time-based criteria (`EventCondition.within`) silently flip a user out as the
clock advances with **no inbound event** — the #1 correctness pitfall. The
real-time path structurally cannot catch this. An engine-owned cron handles it,
cloned from `check-alerts.ts` (which self-bootstraps `createDatabase` /
`createLogger` from `process.env` because cron runs have no request container)
plus the SDK's `onCrons` flag (present in `@hatchet-dev/typescript-sdk@1.22.3`,
currently unused anywhere in the repo — so it must be validated on hatchet-lite /
Railway before being relied upon; a missed/late tick only *delays* a leave, it
never corrupts membership).

```ts
// packages/engine/src/workflows/bucket-reconcile.ts
import { createDatabase } from "@hogsend/db";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";

export const bucketReconcileTask = hatchet.task({
  name: "bucket-reconcile",
  onCrons: [process.env.BUCKET_RECONCILE_CRON ?? "*/5 * * * *"],
  retries: 1,
  executionTimeout: "120s", // per-bucket runs self-requeue if they overrun
  // NON-cancelling overlap guard (NOT CANCEL_IN_PROGRESS): a sweep that overruns
  // the interval must be allowed to FINISH, not be cancelled — else an expiration
  // never completes and members are stuck active forever. Pick a strategy that
  // does NOT kill the in-flight run (queue/drop the newcomer, not cancel the
  // incumbent), OR — cleaner and recommended — split into PER-BUCKET runs (one
  // task run per timeBased bucket) so one large bucket can't block the rest and
  // a single key bounds each run. Confirm the exact non-cancelling strategy enum
  // against the installed @hatchet-dev/typescript-sdk before pinning it.
  concurrency: { /* non-cancelling, maxRuns: 1; see note */ },
  fn: async () => {
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    const registry = getBucketRegistrySingleton();
    // for each timeBased, kind:"dynamic" bucket: SHOULD-LEAVE query per criterion
    // shape (below) → bulk CAS transition → emit bucket:left (gated on RETURNING).
    // kind:"manual" buckets are SKIPPED (early-continue).
    return { reconciled: true };
  },
});
```

**Candidate narrowing (so it is O(active members), never O(all contacts)):**

- Only sweep buckets flagged `meta.timeBased` **and** `kind:"dynamic"` (inferred
  from a `within` in the criteria walk) — the only kind a clock can change. Manual
  buckets early-continue.
- **The SHOULD-LEAVE query must match the CRITERION SHAPE — a single `NOT EXISTS`
  is WRONG for count/operator criteria.** The earlier spec used one `NOT EXISTS`
  for all time-based buckets; that detects leaves only for `not_exists`/existence
  criteria. A `power-users` member whose windowed count decays from 12 to 4 as the
  window slides STILL satisfies `EXISTS` (events still present) but no longer
  satisfies `count gte 10` — `NOT EXISTS` is false, so the leave is never detected
  and the member is **stuck forever**. Per criterion:
  - `check:"not_exists"` (absence bucket, e.g. `went-dormant`) — a member SHOULD
    LEAVE when an event reappears in the window, i.e. **`EXISTS` within window**
    becomes true. (The *join* is what `NOT EXISTS` detects for absence buckets.)
  - `check:"exists"` (positive existence) — SHOULD LEAVE when **`NOT EXISTS`
    within window**.
  - `check:"count"` with `operator`/`value` — SHOULD LEAVE when the **windowed
    count no longer satisfies the operator**, e.g. for `gte N`:
    `count(*) FILTER (WHERE occurredAt >= cutoff) < N`. Expressed set-based as a
    `GROUP BY userId HAVING ...` over the bucket's active members.
- **Prefer a SINGLE set-based bulk transition over per-member re-confirmation.**
  The earlier design ran the SHOULD-LEAVE query AND THEN re-confirmed each
  candidate with a per-user `evaluateCondition` (its own `count(*)`), making the
  cron **O(active_members) DB round-trips** — ~10k point queries every 5 min per
  10k-member bucket, several buckets → tens of thousands of point queries per tick,
  blowing the `executionTimeout`. Instead: for single-event/within/count criteria,
  the SHOULD-LEAVE SQL IS the authoritative set-based evaluation — transition those
  rows in **one bulk CAS** `UPDATE ... SET status='left', leftAt=now() WHERE id IN
  (<set-based result>) AND status='active' RETURNING id, entry_count`, then emit
  `bucket:left` for each returned row (gated on RETURNING, like the real-time path).
  No per-member `evaluateCondition`.
- **Per-user `evaluateCondition` is reserved ONLY for composite/multi-condition
  time-based buckets** where a single SQL predicate cannot express membership. For
  those, chunk via `BATCH_SIZE = 500` keyed on `lastEvaluatedAt`
  (`bucket_memberships_last_evaluated_idx`), and size `executionTimeout`
  accordingly OR make the task **self-requeue as a continuation** rather than
  relying on a single 120s run. The cheap set-based pre-filter, when used, MUST be
  a **superset** of real leavers (never miss one).
- **`reconcileJoins`** (default off): only when on does the sweep scan
  recent-event users not yet members (joins are already caught real-time). For
  absence buckets the JOIN is itself the `NOT EXISTS`-within-window case, so the
  sweep with `reconcileJoins` is what materializes `went-dormant` joins. Keep off
  for non-absence buckets to bound cost.
- Never backfill in a migration (engine migrations run under a 15min statement
  timeout).

**Index / plan validation (Phase 2 acceptance).** The SHOULD-LEAVE query's outer
scan over active members is served by `bucket_memberships_bucket_id_status_idx`;
the per-member event probe is served by `user_events_user_event_occurred_idx`
(`userId, event, occurredAt`). But the planner's choice (semi/anti-join vs nested
loop) is NOT asserted as fact — add an **EXPLAIN-validation step** at
representative scale (10k members, multi-million `user_events`) confirming an
anti-join / index-only path. If the planner picks nested loops, add a covering
index or rewrite as `LEFT JOIN ... WHERE ue.id IS NULL`. State the expected plan in
the implementation PR rather than asserting cost without a plan.

**Absence-leave latency** is bounded by the cron cadence (default 5 min) and is
**surfaced, not hidden** — Studio shows a "building / live" status (Section 11).

### 6.5 Optional fast-expiry timer (Approach A graft, opt-in)

For `meta.fastExpiry` buckets, on **join** the engine arms a single per-user
durable timer so the leave fires near the deadline instead of waiting up to the
cron cadence. This reuses Hatchet `ctx.sleepFor` — the same durable primitive
`performSleep` uses for journey sleeps (`journey-context.ts:131`), which is
proven in production (vs `onCrons`, which is not).

```ts
// armed on join; expiresAt persisted on the membership row
export const bucketExpiryTask = hatchet.durableTask({
  name: "bucket-expiry",
  onEvents: ["bucket:arm-expiry"], // bucket:-prefixed → recursion-guarded
  retries: 0,
  fn: async (input, ctx) => {
    await ctx.sleepFor(input.msUntilExpiry);
    // on wake: re-confirm criteria, then leave via a SINGLE atomic CAS keyed on
    // the ARMED expiresAt — do NOT read-then-act. A concurrent real-time event
    // that re-armed the window (new expiresAt) makes the CAS match zero rows, so
    // the stale timer no-ops WITHOUT emitting a spurious bucket:left:
    //
    //   const left = await db.update(bucketMemberships)
    //     .set({ status: "left", leftAt: new Date() })
    //     .where(and(
    //       eq(bucketMemberships.id, input.rowId),
    //       eq(bucketMemberships.status, "active"),
    //       eq(bucketMemberships.expiresAt, input.armedExpiresAt), // armed epoch
    //     ))
    //     .returning({ id: ..., entryCount: ... });
    //   if (left.length === 1) await emitBucket("left", ..., left[0].entryCount);
    //
    // The cron remains the backstop for any timer lost to worker churn.
  },
});
```

The persisted `expiresAt` field is the **timer-arming epoch** that disambiguates
overlapping/re-armed timers (the crisp fix for Approach A's overlap ambiguity) —
distinct from the membership `entryCount` epoch used in the emission idempotencyKey
(Section 6.3). Collapsing the timer's read-confirm-write into ONE conditional
`UPDATE ... WHERE id=? AND status='active' AND expires_at=:armed RETURNING id`
(emit only on a returned row) is the same CAS pattern the real-time LEAVE uses, and
is what prevents a re-armed window from triggering a spurious leave. The cron sweep
also reads `expiresAt`, so a lost timer is still caught.

**Cardinality is bounded by MEMBERSHIP, not by opted-in bucket count.** Every
active member of a `fastExpiry` bucket arms one live durable timer (one Hatchet
`durableTask` run per member). For a popular absence bucket like `went-dormant`,
that is `O(active members)` — a large fraction of P, not "O(opted-in buckets)".
Journeys are durableTasks too but are bounded by enrollment; an absence bucket can
hold a huge STANDING membership. Guardrails:

- The live-durableTask count = **sum of active members across all `fastExpiry`
  buckets** — treat it as a Hatchet worker capacity-planning input.
- Cap `fastExpiry` to buckets with **bounded** membership; consider a
  max-membership threshold above which `fastExpiry` silently degrades to cron-only.
- `fastExpiry`-on-by-default for ALL time-based buckets is **rejected** (Open
  Question 1): it would arm one timer per member of every time-based bucket.

### 6.6 Initial backfill + criteria-change re-evaluation

Backfill is a **reconcile-style diff**, not an insert-only pass. It runs in two
distinct situations with **different emit semantics**:

**A. First-time backfill (a NEW bucket id appears).**

- Compute the full member set with a **SET-BASED query per criteria shape** — NOT
  a per-contact `evaluateCondition` loop (that would be O(P) serial point queries,
  the same trap as the cron at full P scale). Examples:
  - `event check:count gte N within W` →
    `SELECT user_id FROM user_events WHERE event = :name AND occurred_at >= :cutoff
     GROUP BY user_id HAVING count(*) >= :N`.
  - `event check:exists within W` → `SELECT DISTINCT user_id ... WHERE ... >= cutoff`.
  - `event check:not_exists within W` (absence) → contacts/users with NO such row
    in the window (anti-join against the event set).
  - pure `property` criteria → over `contacts` (`contacts.properties` JSONB).
  - **composite that cannot be expressed in one SQL pass** → documented fallback to
    a chunked per-contact `evaluateCondition` loop, with its O(P) cost called out.
- **Insert `active` rows in batches** (`source: "backfill"`, `BATCH_SIZE = 500`
  reusing the `import-contacts` precedent), `onConflictDoNothing` on the active
  partial index so re-runs are idempotent. Chunking key: paginate by `userId`
  range or by the grouped result.
- **Suppress live join emission** for first-time backfilled matches (Customer.io's
  rule: historical matches must NOT fire `bucket:entered` into live journeys). The
  `source: "backfill"` rows exist for membership/Studio but do not recurse into
  `ingestEvent`.

**B. Criteria-change re-evaluation (an EXISTING bucket's criteria edited).** The
trigger was previously hand-waved ("or criteria change") with no detection
mechanism — criteria live in code, the registry is rebuilt fresh on every boot
with no memory of the prior definition, so an edit + redeploy left stale `active`
members lingering and re-running backfill would hit the unique index trying to
insert active rows for users who already have one. The mechanism:

- **Persist a criteria fingerprint** — a stable hash of the normalized
  `ConditionEval` — on `bucket_configs` (new `criteriaHash` column) or a dedicated
  column. On worker boot, diff the registry's current criteria hash against the
  stored one; **on change**, enqueue a full re-evaluation Hatchet job. This is also
  the natural "new bucket vs changed bucket" detector that first-time backfill
  needs.
- The re-eval job is a **full diff**, NOT insert-only:
  - (a) INSERT active rows for NEW matchers (`source: "backfill"`,
    `onConflictDoNothing` so existing active rows are untouched);
  - (b) **transition active members who no longer match → `left`** via the CAS
    UPDATE (this is the step the earlier insert-only spec omitted).
- **Emit semantics differ from first-time backfill:** per Customer.io ("edit
  re-evaluates exit conditions"), criteria-change **LEAVES SHOULD EMIT**
  `bucket:left` (so in-flight journeys exit via `exitOn`), while criteria-change
  **JOINS do NOT emit** (same suppression as first-time backfill — don't blast
  `bucket:entered` into live journeys on an edit). This asymmetry is intentional
  and documented in Open Question 6.

**Status tracking (Studio "building / live" badge).** Backfill/re-eval needs a
persisted progress record — the engine already has `import_jobs`
(`import-jobs.ts`: status enum, `totalRows`/`processedRows`/`failedRows`,
timestamps) as the exact precedent. Either add a `bucket_backfill_jobs` table
mirroring `import_jobs` (`bucketId`, status, total/processed/failed, timestamps) or
reuse `import_jobs` with a discriminator. The Section 11.3 "building / live" badge
**derives from this record**, not from a bare `lastEvaluatedAt` checkpoint.

- These run as chunked, idempotent, resumable Hatchet tasks (Hatchet retries) —
  never in a migration. v1 may ship backfill as an admin endpoint that enqueues the
  job (explicit "build" action is safer for large audiences — Open Question 6); the
  cron's `reconcileJoins=true` mode can also perform a one-time backfill pass.

---

## 7. How a bucket triggers a journey (end-to-end)

A journey binds to a bucket transition with **zero engine changes** — it rides
the existing Hatchet `onEvents` routing. Recommended: bind to the **narrow
alias** so the durable task is only woken for that bucket.

```ts
// apps/api/src/journeys/winback.ts
import { defineJourney, days, sendEmail } from "@hogsend/engine";
import { bucketEntered, bucketLeft, Templates } from "./constants/index.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    name: "Winback dormant users",
    enabled: true,
    // Narrow alias → Hatchet routes ONLY went-dormant joins to this task.
    trigger: { event: bucketEntered("went-dormant") }, // "bucket:entered:went-dormant"
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    // Auto-exit if the user re-activates and leaves the bucket mid-journey
    // (Approach C graft — free via the existing checkExits path).
    exitOn: [{ event: bucketLeft("went-dormant") }], // "bucket:left:went-dormant"
    suppress: days(7),
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: Templates.WINBACK, userId: user.id });
    await ctx.sleep({ duration: days(3) });
    // ... follow-up
  },
});
```

Flow (`went-dormant` is an ABSENCE bucket: a user **enters** it when they go
quiet, and **leaves** it the moment they return):

1. The user stops firing `app.active`. No inbound event signals this, so the
   real-time path cannot catch it — the reconcile sweep owns it. With
   `reconcileJoins` on for this absence bucket, the sweep's JOIN query (`NOT EXISTS`
   `app.active` within 7d, the absence-bucket join shape from Section 6.4) finds
   the user now matches, inserts an `active` `went-dormant` membership, and — being
   a real (non-backfill) transition — emits `bucket:entered:went-dormant` via
   `ingestEvent` (subject to the `reentry` gate; here `entryLimit` lives on the
   journey side).
2. `ingestEvent` pushes `bucket:entered:went-dormant` to Hatchet
   (`ingestion.ts:73`). Hatchet routes it to the `winback` journey task
   (`onEvents: ["bucket:entered:went-dormant"]`).
3. The journey's enrollment guards run (`entryLimit`/`already_active`), a
   `journeyStates` row is created, and `run()` sends the winback email.
4. If the user re-activates, their next `app.active` event hits the **real-time**
   path, which detects `went-dormant` membership should flip to `left` (the
   absence criterion is no longer satisfied), emits `bucket:left:went-dormant` via
   the CAS-gated LEAVE, and `checkExits` exits the in-flight `winback` journey
   (because it declared that `exitOn`).

---

## 8. Data model

Two new **ENGINE-track** tables (they mirror engine-owned tables and are read by
engine code). They live in `packages/db/src/schema/`, are exported from
`index.ts`, generated via `cd packages/db && pnpm db:generate` (produces a new
`0011_*` migration + snapshot + `meta/_journal.json` entry), and applied by the
engine track `pnpm db:migrate` → `__drizzle_migrations`. **Not** the client
track.

### 8.1 New enum (`packages/db/src/schema/enums.ts`)

```ts
export const bucketMembershipStatusEnum = pgEnum("bucket_membership_status", [
  "active",
  "left",
]);
```

Minimal vs the journey's 5 statuses — buckets are membership, not flows.

### 8.2 `bucket_memberships` (mirrors `journey-states.ts`)

```ts
// packages/db/src/schema/bucket-memberships.ts
import { sql } from "drizzle-orm";
import {
  index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { bucketMembershipStatusEnum } from "./enums.js";

export const bucketMemberships = pgTable(
  "bucket_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // multi-tenant insurance (nullable today, NOT in the unique key — see note)
    organizationId: text("organization_id"),
    // logical join to contacts.externalId — NO FK (matches userEvents /
    // journeyStates; membership rows can predate a contacts row).
    userId: text("user_id").notNull(),
    userEmail: text("user_email"), // denormalized so emitted events carry it
    bucketId: text("bucket_id").notNull(),
    status: bucketMembershipStatusEnum("status").notNull().default("active"),
    enteredAt: timestamp("entered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // membership epoch / armed deadline for time-based + fastExpiry buckets
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    entryCount: integer("entry_count").notNull().default(1),
    source: text("source"), // "event" | "reconcile" | "backfill" | "manual"
    context: jsonb("context").$type<Record<string, unknown>>().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // EXACTLY ONE ACTIVE membership per (user, bucket), with any number of
    // historical "left" rows coexisting. This is a PARTIAL unique index scoped
    // to active, non-deleted rows — NOT a plain (userId,bucketId,status) unique
    // index. Buckets are re-entrant: a user oscillates join → leave → join →
    // leave forever, so a plain unique key on (userId,bucketId,status) would
    // throw on the SECOND "left" row (two rows share (user,bucket,'left')). The
    // journeyStates model does NOT transfer here because journey terminal states
    // are reached once; bucket "left" is reached repeatedly. drizzle expresses a
    // partial unique index via .where(sql`...`):
    //   uniqueIndex("uq_user_bucket_active")
    //     .on(table.userId, table.bucketId)
    //     .where(sql`status = 'active' AND deleted_at IS NULL`)
    // (drizzle 0.45.2 partial-unique support MUST be confirmed at Phase 1; the
    // generated SQL is `CREATE UNIQUE INDEX uq_user_bucket_active ON
    // bucket_memberships (user_id, bucket_id) WHERE status = 'active' AND
    // deleted_at IS NULL`. If drizzle cannot emit it, hand-write it in the
    // migration file after db:generate.)
    // organizationId deliberately OMITTED — same NULLS-DISTINCT caveat as
    // uq_user_journey_active (journey-states.ts:34-40). Add it to the predicate
    // only when multi-tenancy lands and the column is non-null.
    uniqueIndex("uq_user_bucket_active")
      .on(table.userId, table.bucketId)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    index("bucket_memberships_bucket_id_status_idx").on(
      table.bucketId,
      table.status,
    ), // list members / size metrics
    index("bucket_memberships_user_id_idx").on(table.userId), // a user's buckets
    index("bucket_memberships_last_evaluated_idx").on(table.lastEvaluatedAt),
    index("bucket_memberships_expires_at_idx").on(table.expiresAt),
  ],
);
```

**Re-entrant membership lifecycle (the load-bearing model).** A `(user, bucket)`
pair is evaluated forever, so membership is NOT a single mutable row. Instead:

- **JOIN** always `INSERT`s a **fresh** `active` row (a new `id`, fresh
  `enteredAt`). Historical `left` rows are retained for metrics (Section 11.2
  reads dwell + total-entered/left over them).
- **LEAVE** sets the CURRENT active row's `status = "left"`, `leftAt = now()` via
  a compare-and-swap UPDATE (Section 6.3). The row is no longer active, so the
  partial unique index permits the NEXT join's fresh active row.
- **`entryCount`** is denormalized onto each new active row as `1 + (count of
  prior memberships for this user+bucket)`, computed in the JOIN insert, so
  Studio can surface re-entries. (It is NOT mutated in place; each active row
  records its own entry ordinal.)

This makes `join → leave → join → leave → join` (3 full cycles) produce three
`left` rows + one final `active` row with **no unique violation** — a mandatory
Phase 1 acceptance test (Section 14).

> Note flagged to the lead: the analogous `uq_user_journey_active` on
> `journey-states.ts` shares the same latent flaw for any journey that re-reaches
> a terminal status (e.g. a second `UPDATE status='completed'`). It is latent for
> journeys (terminal states are reached at most once per enrollment under the
> active-state guard) but would surface if re-completion were ever introduced.
> Tracked as a separate engine concern, out of scope for this spec.

### 8.3 `bucket_configs` (exact clone of `journey-configs.ts`)

```ts
// packages/db/src/schema/bucket-configs.ts
import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const bucketConfigs = pgTable(
  "bucket_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bucketId: text("bucket_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Stable hash of the normalized ConditionEval, written at boot. Diffed on the
    // next boot to detect a CRITERIA CHANGE and enqueue the re-evaluation job
    // (Section 6.6 B). Nullable until the first registration.
    criteriaHash: text("criteria_hash"),
    ...timestamps,
  },
  (table) => [uniqueIndex("bucket_configs_bucket_id_idx").on(table.bucketId)],
);
```

The `enabled` flag is consulted via the **in-memory enabled-override map** loaded
once per process (Section 6.2) — NOT a per-candidate-per-event
`findFirst` — and CRUD'd by the admin route with `onConflictDoUpdate` on
`bucketConfigs.bucketId`, mirroring `routes/admin/journeys.ts` (which also
invalidates the in-memory cache on write). `criteriaHash` is read/written at worker
boot for criteria-change detection.

### 8.4 Relations + exports

- `packages/db/src/schema/relations.ts`: add `bucketMembershipsRelations`
  linking `bucketMemberships.userId → contacts.externalId` (mirror
  `journeyStatesRelations`); add `bucketMemberships: many(...)` to
  `contactsRelations`. `bucketConfigsRelations` is empty like
  `journeyConfigsRelations`.
- `packages/db/src/schema/index.ts`: export both new files.

### 8.5 Relationship to existing tables

- **`contacts`** — `bucket_memberships.userId` logically joins
  `contacts.externalId` (the universal join key; no FK, matching
  `userEvents`/`journeyStates`).
- **`userEvents`** — criteria evaluation (`event`/count/`within`) reads
  `userEvents`; emitted `bucket:*` events are stored back into `userEvents`,
  making them available to journeys, `exitOn`, and Studio history.
  - **Row-growth note (resolves Open Question 3 in favor of aliased-only).** The
    earlier design emitted BOTH a generic `bucket:entered` AND an aliased
    `bucket:entered:<id>` per transition — 2 rows + 2 Hatchet pushes + 2
    `checkExits` scans + 2 contact upserts per logical transition, and at a churny
    boundary this emission cost DOMINATES the criteria eval. Because the recursion
    guard means the generic event has **no membership-eval value** and Hatchet
    routing favors the alias, the **default is to emit ONLY the alias** to
    `userEvents`/Hatchet, and derive the generic `bucket:entered` for Hatchet
    routing **only if a generic-bound journey actually exists** (cross-referenced
    via `journeyRegistry.getByTriggerEvent("bucket:entered")`). This halves every
    per-transition cost line. If both are ever emitted, document the 2× growth and
    add a retention/pruning note for `bucket:*` rows so the hot `userEvents` table
    (scanned by every count(*) criterion) does not bloat.
- **`journeyStates`** — unchanged. Journeys triggered by a bucket create normal
  `journeyStates` rows; the `bucket:left:<id>` `exitOn` exits them via the
  existing `checkExits`.

### 8.6 Contact deletion / GDPR cascade

The engine's contact delete route (`routes/admin/contacts.ts:336`) soft-deletes
(sets `contacts.deletedAt`) and does NOT cascade to `journeyStates` today. Buckets
add a THIRD user-keyed, no-FK table with its own `deletedAt`, so deletion MUST be
handled explicitly or deleted contacts linger as `active` members, the cron/
real-time paths keep evaluating them, Studio counts stay inflated, and the cron
could even emit `bucket:left` for a deleted user and fire a journey post-deletion.

Required behavior:

1. The contact delete route also **soft-deletes `bucket_memberships`** for that
   `userId` (set `deletedAt`; optionally flip `status` to `left` without emitting).
2. `checkBucketMembership` and the reconcile SHOULD-LEAVE query both **exclude
   users whose `contacts.deletedAt` is set** (or skip when no live contact exists).
3. **`bucket:*` emission is suppressed for deleted contacts** so no journey fires
   post-deletion.
4. Studio member counts / metrics **filter `deletedAt IS NULL`** (already implied
   by `isNull(deletedAt)` in the members query — extend to the contact join).

> Flagged to the lead (out of scope here): the parallel gap that contact deletion
> does not cascade to `journeyStates` is a pre-existing engine concern.

---

## 9. Engine/consumer boundary & wiring

The split mirrors journeys exactly: the **factory** is FRAMEWORK
(`@hogsend/engine`); the **definitions** are CONTENT (consumer `src/buckets/`).

### 9.1 What lives where

| Piece | Location | Mirrors |
| --- | --- | --- |
| `BucketMeta`, `bucketMetaSchema`, `BucketRegistry` | `@hogsend/core` | `JourneyMeta` / `journeyMetaSchema` / `JourneyRegistry` |
| `defineBucket`, `DefinedBucket` | `@hogsend/engine` (`buckets/define-bucket.ts`) | `defineJourney` |
| `buildBucketRegistry`, `selectBucketTasks`, `parseEnabledFilter` (reused) | `@hogsend/engine` (`buckets/registry.ts`) | `journeys/registry.ts` |
| `setBucketRegistry` / `getBucketRegistrySingleton` / `resetBucketRegistry` | `@hogsend/engine` (`buckets/registry-singleton.ts`) | `journeys/registry-singleton.ts` |
| `bucketReconcileTask`, `bucketExpiryTask` | `@hogsend/engine` (`workflows/bucket-reconcile.ts`) | `workflows/check-alerts.ts` |
| `bucket_memberships`, `bucket_configs` | `@hogsend/db` | `journey-states.ts` / `journey-configs.ts` |
| Bucket definitions + `Events` constants | consumer `apps/api/src/buckets/` + `journeys/constants/events.ts` | `apps/api/src/journeys/` |

### 9.2 `BucketRegistry` (in `@hogsend/core`, mirrors `JourneyRegistry`)

Clone `packages/core/src/registry/index.ts`. The id map plus TWO inverted indexes
(`eventIndex` + `propertyIndex`) for candidate narrowing — the `propertyIndex` is
mandatory so property-only buckets are not re-evaluated on every event (Section
6.2):

```ts
export class BucketRegistry {
  private buckets: Map<string, BucketMeta> = new Map();
  private eventIndex: Map<string, BucketMeta[]> = new Map();
  private propertyIndex: Map<string, BucketMeta[]> = new Map();
  private wildcard: BucketMeta[] = []; // degenerate: no event, no property ref

  register(bucket: BucketMeta): void {
    const validated = bucketMetaSchema.parse(bucket) as unknown as BucketMeta;
    this.buckets.set(validated.id, validated);
    // manual buckets are not criteria-driven → not indexed for real-time eval
    if (validated.kind === "manual" || !validated.criteria) return;

    const events = collectEventNames(validated.criteria);
    const props = collectPropertyNames(validated.criteria);
    for (const eventName of events) {
      this.eventIndex.set(eventName, [
        ...(this.eventIndex.get(eventName) ?? []), validated,
      ]);
    }
    for (const propName of props) {
      this.propertyIndex.set(propName, [
        ...(this.propertyIndex.get(propName) ?? []), validated,
      ]);
    }
    // "*" ONLY for criteria referencing neither a concrete event nor a property
    // (degenerate; rare under the at-least-one-positive rule).
    if (events.length === 0 && props.length === 0) this.wildcard.push(validated);
  }

  get(id: string): BucketMeta | undefined { return this.buckets.get(id); }
  getByReferencedEvent(eventName: string): BucketMeta[] {
    return [...(this.eventIndex.get(eventName) ?? []), ...this.wildcard];
  }
  getByReferencedProperty(propName: string): BucketMeta[] {
    return this.propertyIndex.get(propName) ?? [];
  }
  getAll(): BucketMeta[] { return Array.from(this.buckets.values()); }
  getEnabled(): BucketMeta[] { return this.getAll().filter((b) => b.enabled); }
  has(id: string): boolean { return this.buckets.has(id); }
  count(): number { return this.buckets.size; }
}
```

`collectEventNames(criteria)` walks the `ConditionEval` tree collecting every
`EventCondition.eventName`; `collectPropertyNames(criteria)` walks the same tree
collecting every `PropertyCondition.property`. Both are pure tree walks over the
discriminated union, mirroring `core/conditions/event.ts`.

### 9.3 `ENABLED_BUCKETS` env

Add to `packages/engine/src/env.ts` mirroring `ENABLED_JOURNEYS`:

```ts
ENABLED_BUCKETS: z.string().default("*"),
BUCKET_RECONCILE_CRON: z.string().default("*/5 * * * *"),
```

`parseEnabledFilter` (`journeys/registry.ts:9`) is reused as-is. **Operator
note:** `ENABLED_BUCKETS` and `onCrons` are evaluated at **worker boot** — a
toggle requires a worker restart. Only the `bucket_configs` DB override is hot
(same asymmetry as journeys; document it).

### 9.4 `createHogsendClient` + `createWorker` options

Add `buckets?: DefinedBucket[]` to `HogsendClientOptions`
(`container.ts:77-149`, default `[]`). At client build, call
`buildBucketRegistry(opts.buckets ?? [], opts.enabledBuckets ?? env.ENABLED_BUCKETS)`
(installs the singleton in **both** the API and worker processes, since both call
`createHogsendClient`) and expose `bucketRegistry` on the returned
`HogsendClient`. The real-time path reads the singleton via
`getBucketRegistrySingleton()`.

Add `buckets?: DefinedBucket[]` to `CreateWorkerOptions` (`worker.ts:11-18`).
Always register `bucketReconcileTask` in `baseWorkflows` (`worker.ts:30`); append
`...selectBucketTasks(buckets, enabled)`:

```ts
const baseWorkflows = [
  sendEmailTask, importContactsTask, checkAlertsTask, bucketReconcileTask,
  ...journeyTasks, ...selectBucketTasks(buckets, enabledBuckets),
];
```

`selectBucketTasks` is the **single place** a bucket's per-user fast-expiry
durableTask is constructed: it filters `buckets` to the enabled set, and for each
`meta.fastExpiry === true` synthesizes (or attaches) the `bucketExpiryTask`
durableTask. This keeps `defineBucket` a pure passthrough (Section 4.3) — task
construction happens at worker build, AFTER the registry has validated every meta,
not at module-load before validation. (The fast-expiry timer is a single shared
`durableTask` definition keyed on `bucket:arm-expiry`; per-bucket arming is by
event payload, not per-bucket task instances — so `selectBucketTasks` registers it
once if ANY enabled bucket has `fastExpiry`.)

### 9.5 Consumer wiring (`apps/api`)

```ts
// apps/api/src/buckets/index.ts — mirrors journeys/index.ts
import type { DefinedBucket } from "@hogsend/engine";
import { powerUsers } from "./power-users.js";
import { trialExpiringSoon } from "./trial-expiring-soon.js";
import { wentDormant } from "./went-dormant.js";

export const buckets: DefinedBucket[] = [
  powerUsers, trialExpiringSoon, wentDormant,
];
```

```ts
// apps/api/src/index.ts (HTTP) and src/worker.ts (worker)
import { buckets } from "./buckets/index.js";
const client = createHogsendClient({ journeys, buckets, email: { templates } });
// worker.ts:
createWorker({ container: client, journeys, buckets });
```

**`create-hogsend` scaffold parity (do NOT skip).** New apps are scaffolded from
`packages/create-hogsend/template/`, whose `src/index.ts` / `src/worker.ts` call
`createHogsendClient`/`createWorker` WITHOUT a `buckets` option and have no
`src/buckets/` directory. So new apps would ship with no bucket support and diverge
from `apps/api`. Phase 1 (or Phase 3, with the rest of the consumer surface) MUST:

- create `packages/create-hogsend/template/src/buckets/index.ts` —
  `export const buckets: DefinedBucket[] = []` plus one commented example;
- update `template/src/index.ts` and `template/src/worker.ts` to import and pass
  `buckets` to `createHogsendClient` and `createWorker`, mirroring how
  `journeys`/`webhookSources` are wired;
- include the `BucketId`-union helper pattern (Section 4.5) in the template
  constants so scaffolded apps get the typed alias helpers too.

This mirrors the engine-boundary rule that consumer-side patterns (constants,
augmentations) must also be updated in the scaffolder template.

### 9.6 "How to add a bucket" checklist

**No schema change is needed to add a bucket after Phase 1** — the
`bucket_memberships` / `bucket_configs` tables are a one-time Phase 1 concern, so
`db:generate` is NOT a per-bucket step.

**Minimal path (observe-only bucket — the common case):**

1. Create `apps/api/src/buckets/<id>.ts` with `defineBucket({ meta })` using
   `ConditionEval` criteria and duration helpers.
2. Import it in `apps/api/src/buckets/index.ts` and add to the `buckets` array.
   (Because the `BucketId` union is `(typeof buckets)[number]["meta"]["id"]`, this
   keeps the typed alias helpers in sync automatically.)

That's it for a bucket that just exists in Studio.

**Optional path (only if a journey should react):**

3. Add any new event/property constants to `apps/api/src/journeys/constants/`
   (reuse the existing `Events` const so journey triggers and bucket criteria
   share one source of truth).
4. Bind a journey's `trigger.event` to `bucketEntered("<id>")` (and optionally
   `exitOn: [{ event: bucketLeft("<id>") }]`). Prefer the narrow alias; binding to
   the generic `bucket:entered` starts the journey's durable task on EVERY bucket
   transition (see Section 4.5 cost warning).

---

## 10. Worker & scheduling

- `bucketReconcileTask` is registered in `baseWorkflows` (`worker.ts:30`),
  self-bootstrapping its own `db`/`logger` (no request container), cloned from
  `check-alerts.ts`. Its `onCrons` schedule registers when the worker boots.
- **Non-cancelling concurrency guard** (a single-run lock that lets an in-flight
  sweep FINISH, or per-bucket runs) — NOT `CANCEL_IN_PROGRESS`. Cancelling an
  overrunning sweep would leave expirations incomplete and members stuck `active`
  forever. Splitting into per-bucket runs is recommended so one large bucket can't
  starve the rest (Section 6.4).
- `bucketExpiryTask` (for `fastExpiry` buckets) is a `durableTask` keyed on
  `onEvents: ["bucket:arm-expiry"]`, reusing `ctx.sleepFor`. Live-timer cardinality
  = sum of active members across `fastExpiry` buckets (Section 6.5) — a worker
  capacity-planning input, not "one per opted-in bucket".
- **Validation gate:** `onCrons` has zero prior usage in this repo
  (`check-alerts` is registered but never scheduled). Before relying on the cron,
  confirm hatchet-lite on Railway fires it. Because a missed tick only delays a
  leave (never corrupts state), the cron is a safe backstop while this is
  validated; the `fastExpiry` durable-timer path (proven `ctx.sleepFor`) covers
  latency-critical buckets in the interim.

---

## 11. Observability (observe-not-author)

Mirror the journeys admin/Studio spine. Admin auth/rate-limit/audit are applied
once at `routes/admin/index.ts:24-26`, so a bucketsRouter inherits them for free.

### 11.1 Engine admin API (`packages/engine/src/routes/admin/buckets.ts`)

Clone `routes/admin/journeys.ts` and mount with
`adminRouter.route("/buckets", bucketsRouter)` after the journeys mount:

- `GET /v1/admin/buckets` — list. Walk `bucketRegistry.getAll()`, one grouped
  query over `bucket_memberships GROUP BY (bucketId, status)` for member counts,
  merge the `bucket_configs` enabled override
  (`effectiveEnabled = dbEnabled !== undefined ? dbEnabled : meta.enabled`).
- `GET /v1/admin/buckets/{id}` — detail + metadata + recent members + a derived
  list of **which journeys it feeds** (cross-reference `bucketRegistry` emitted
  event names against `journeyRegistry.getByTriggerEvent("bucket:entered:<id>")`),
  rendered as badges.
- `GET /v1/admin/buckets/{id}/members` — paginated current members (`limit`/
  `offset`, response `{ members, total, limit, offset }`, filtered
  `status = "active"` AND `isNull(deletedAt)`, `desc(enteredAt)`). Historical
  `left` rows are excluded from the member list but feed the dwell/entered/left
  metrics in 11.2.
- `PATCH /v1/admin/buckets/{id}` — enable/disable via `onConflictDoUpdate` on
  `bucket_configs.bucketId`. **Use PATCH on both engine and Studio sides** — do
  not replicate the journeys PATCH-vs-PUT drift.

### 11.2 Engine metrics (`routes/admin/metrics.ts`)

Reuse `rate()` and `TRUNC_SQL` from `lib/metrics-sql.ts`:

- `GET /v1/admin/metrics/buckets` — per-bucket current size (active members),
  total entered/left, avg dwell time
  (`avg(extract(epoch from coalesce(leftAt, now()) - enteredAt))`).
- `GET /v1/admin/metrics/buckets/{id}` — size-over-time and entered/left
  time-series via `date_trunc(TRUNC_SQL[period], col)::text` GROUP BY (same as
  `deliverabilityRoute`).
- Add `activeBuckets` / `bucketMembers` to the overview KPIs (same
  `inArray(status, ["active"])` pattern as `activeJourneys`).

### 11.3 Studio (`packages/studio`)

Studio is **read-only over HTTP** with exactly **one** mutation (enable/disable),
mirroring `journeys-view.tsx`:

- Nav: add `{ label: "Buckets", path: "/buckets", icon: Boxes }` to
  `components/layout/nav.ts`; register the route.
- Data layer (`lib/admin-api.ts`): add `Bucket*` types + fetchers (`listBuckets`,
  `listBucketMetrics`, `listBucketMembers`, `getBucketTrend`, `setBucketEnabled`
  via **PATCH**) + `qk.buckets` keys, hand-mirroring the engine Zod schemas.
- `views/buckets-view.tsx`: merge metrics + enabled-flag queries by id; columns
  (Current size / Entered / Left / Feeds journeys / State); expand a
  size-over-time chart (reuse `components/bar-chart.tsx`) and entered/left funnel
  (reuse `views/journeys/journey-funnel.tsx`); enable/disable behind a
  `ConfirmDialog`. **A "building / live" badge** surfaces backfill + cron-cadence
  lag honestly — it derives from the backfill status record (Section 6.6,
  `bucket_backfill_jobs` / `import_jobs`), not a bare checkpoint.
- **No create/edit-bucket UI, ever** — authoring stays code-first.

---

## 12. Optional PostHog sync

Off by default. When `meta.syncToPostHog` is true, on join/leave the engine sets
a **boolean person property** via the existing `plugin-posthog` capture
(`ctx.posthog.capture` / `getPostHog()`, the same path `identify()` uses at
`journey-context.ts:199-200` / `plugin-posthog service.ts:40-41`):

- **Join** — `$set { [propertyKey]: true }` (default `propertyKey =
  hogsend_bucket_<id>`).
- **Leave — `$unset [propertyKey]` (RECOMMENDED default).** `$unset` and
  `$set { key: false }` are **NOT interchangeable** for downstream cohort authors:
  a cohort `key = true` excludes a false value, but a cohort `key is set` STILL
  matches a false value. `$unset` is cleanest — the property is absent unless the
  user is currently a member, so both `key = true` and `key is set` behave
  correctly. (`$set false` is allowed only if an author deliberately wants a
  sticky falsy value; it is not the default.)

A PostHog cohort defined on `hogsend_bucket_<id> = true` is
**person-property-only**, which PostHog inlines and evaluates **in real time** in
CDP destinations and feature flags. The honest framing (no overclaim): **"Buckets
give PostHog cohorts a real-time-evaluable membership signal PostHog cannot compute
itself."** The `$set` lands in PostHog **as fast as Hogsend detects the
transition** (event-driven: sub-second; absence/time-based: bounded by the
reconcile cadence or `fastExpiry`), **then** PostHog evaluates the resulting
person-property cohort in real time — the "real-time" is PostHog's evaluation AFTER
the property lands, not the transition reaching PostHog. The sync is a **no-op
without `POSTHOG_API_KEY`** (best-effort capture; silently does nothing in
self-host setups that omit PostHog — documented, not broken). This is additive,
reuses the existing capture path, adds no new integration surface, and never pushes
to Braze/HubSpot/Segment (the Section 2.4 anti-CDP invariant). Static PostHog-cohort
push (`PATCH /cohorts/:id/add_persons_to_static_cohort`) is a possible bulk/export
alternative but lacks the real-time inlining benefit; prefer the `$set`/`$unset`
approach.

---

## 13. Security, scale & edge cases

**Security.** Bucket admin routes inherit `requireAdmin` + `rateLimit` +
`auditMiddleware` from `routes/admin/index.ts`. Emitted `bucket:*` events go
through the same trusted internal `ingestEvent` path (not an external ingress).
The `bucket:` reserved prefix should be rejected on the **public** `/v1` ingest
route so external callers cannot spoof transitions.

**Scale** (N buckets, M events/sec, P contacts):

- **Real-time eval path** is **not** O(N) — candidate narrowing evaluates only
  `K << N` buckets per event, where **`K` = buckets referencing this event name
  (eventIndex) OR a property present in this payload (propertyIndex)**, plus the
  rare degenerate `"*"` set. Pure-property criteria are in-memory (0 DB); each
  `event` sub-condition is one indexed `count(*)`
  (`user_events_user_event_occurred_idx`); composite sub-conditions evaluate
  **serially** (`composite.ts`), so per-candidate latency is the SUM of its DB
  sub-conditions' round-trips (put cheap `PropertyCondition`s first to short-
  circuit). Steady-state per-event eval ceiling: `K × (1 cached membership
  decision + Σ db-subconditions)`. **Worst case:** a hot property touched by every
  event re-evaluates every bucket referencing it. Independent of P; not O(N) for
  the common case. (Earlier text claimed property-only buckets were narrowed but
  the registry filed them all under `"*"` → O(N); the `propertyIndex` fixes this.)
- **Per-transition EMISSION cost (the dominant cost at a churny boundary, omitted
  from earlier model).** One logical transition that emits BOTH generic + alias
  costs **2 `user_events` INSERTs + 2 Hatchet pushes + 2 `journeyStates.findMany`
  (`checkExits`) + 2 contact upserts** — each emitted event is a full recursive
  `ingestEvent`. This is resolved two ways: (1) **aliased-only emission by
  default** (Open Question 3 / Section 8.5) halves every line above; (2) the
  recursive bucket-emit `ingestEvent` should take an internal **fast-path** that
  **skips `upsertContact`** for synthetic `bucket:*` events (pure overhead —
  there is no real contact state in a transition event). `checkExits` is NOT
  skippable (it is how `exitOn:[bucket:left]` works), but it is the only required
  scan.
- **Hot user** firing a burst that matches the same bucket re-evaluates each event
  but emits only on the **first** transition (emission gated on the RETURNING
  mutation, Section 6.3), so journeys are **not** spammed. NOTE: the earlier
  "per-(user,event) eval-result memo for one ingest call" is DROPPED — each event
  is one ingest call evaluating each candidate once, so a one-call memo caches
  nothing reusable. The real hot-event mitigations are: candidate narrowing
  (event+property index), property-first short-circuit ordering, the in-memory
  `bucket_configs` cache, and optionally a short-TTL cross-event cache of a user's
  membership decision during a burst.
- **Reconcile path** is **set-based**, not per-member round-trips. For
  single-event/within/count criteria the SHOULD-LEAVE query is one set-based SQL
  per timeBased bucket → one bulk CAS UPDATE — NOT `O(active_members)` individual
  `evaluateCondition` calls (the earlier design's `~10k point queries / 5 min /
  bucket` that blew the timeout). Per-member `evaluateCondition` is reserved for
  composite time-based buckets only, chunked at `BATCH_SIZE = 500` with self-
  requeue. `reconcileJoins` stays off except for absence buckets.
- **Reconcile cost guardrail** — sweep cost scales with `Σ(active members ×
  window-probe)` across timeBased buckets. This (not a positioning rule) is the
  reason to consider an operational window cap; large absence buckets are the
  expensive case.
- **fastExpiry live-timer cardinality** is `O(Σ active members across fastExpiry
  buckets)` — bounded by MEMBERSHIP, not by opted-in bucket count. Cap fastExpiry
  to bounded-membership buckets (Section 6.5).
- **Backfill** is genuinely O(P)/O(events) — specified as a **set-based query per
  criteria shape** (Section 6.6), inserting in `BATCH_SIZE = 500` chunks, NOT a
  per-contact loop. Composite-only fallback is the documented O(P) exception. Add
  rows-scanned / expected-duration-at-P=1M to the implementation PR.
- **Table growth** — `bucket_memberships` retains historical `left` rows (one
  active + N historical per (user,bucket)) for metrics; index-cheap, but NOT
  "one row per (user,bucket)" as earlier claimed. The hot `user_events` table also
  grows by emitted `bucket:*` rows (1 or 2 per transition) — see the
  aliased-only / pruning note (Section 8.5).

**Edge cases:**

- **Recursion** — `bucket:`-prefixed events MUST early-return from
  `checkBucketMembership` (mandatory, tested). `bucket:*` event names are reserved:
  EventConditions referencing them are rejected at registration (4.2), so
  transition rows can never satisfy a bucket criterion. Buckets-of-buckets deferred
  to avoid transitive loops.
- **Flapping** — emission gated on the atomic mutation + `minDwell` **deferred-not-
  dropped** leave debounce + the bucket-side `reentry`/`reentryPeriod` emit gate
  (Section 6.3) guard against re-enroll spam.
- **Staleness** — property predicates evaluate against **merged contact state**
  (`{ ...contact.properties, ...event.properties }`), NOT the bare event payload
  (Section 6.1 rule #3) — the fix for spurious flapping on events that don't carry
  the referenced props.
- **Read-after-write** — the `userEvents` insert and the bucket count eval share a
  transaction/connection, or the current event is counted arithmetically
  (`db_count + 1`), so a threshold-crossing JOIN is not missed (Section 6.1 rule
  #2); the connection-pooling assumption is documented.
- **Backfill** — first-time backfilled matches do **not** fire live joins;
  criteria-change re-eval LEAVES emit but JOINS do not (Section 6.6).
- **Two-layer re-enrollment gating** — a bucket has its OWN `reentry`/
  `reentryPeriod` emit gate (Section 6.3), AND the journey it triggers has its own
  `entryLimit`/`entryPeriod`. Both apply; authors should not be surprised by
  double-gating. The bucket gate controls whether `bucket:entered` is emitted at
  all; the journey gate controls whether the emitted event enrolls.
- **Convergence invariant** — a documented test asserts that under concurrent
  ingest + an overlapping cron tick, exactly one of {real-time, cron, fast-expiry
  timer} emits a given transition. The guarantee is **emission gated on the
  RETURNING mutation** (the loser mutates zero rows → never emits), with the
  deterministic `idempotencyKey` (epoch = `entryCount`) as defense-in-depth. The
  worked example in Section 6.3 produces byte-identical keys; the test asserts a
  single emission.
- **email_engagement** is flatly forbidden in v1 criteria (Section 5) — rejected at
  registration (enforceable), not gated on an unenforceable `email === externalId`.
- **GDPR / contact deletion** — bucket memberships are soft-deleted and excluded
  from eval/emission when the contact is deleted (Section 8.6).
- **"Safe backstop" scope** — a missed/late cron tick only *delays* a leave
  **for timeBased buckets** (the only kind the cron sweeps). Property-only leaves
  suppressed by `minDwell` rely on the deferred-leave path (Section 6.3
  `deferLeave`), which requires the bucket to be swept (treated as timeBased) or
  fastExpiry-armed — there is NO cron backstop for a property-only bucket that has
  neither, so `minDwell` is rejected on such buckets (Section 6.3 option b) or the
  bucket is treated as timeBased (option a).

---

## 14. Phased implementation plan

Each phase is independently shippable and additive.

### Phase 1 — Core primitive + real-time membership (no time-based leaves)

- `BucketMeta` (incl. `kind` discriminator) + `bucketMetaSchema` (4 superRefine
  rules) + `BucketRegistry` (event + property indexes) in `@hogsend/core`.
- `defineBucket` (pure passthrough) / `DefinedBucket` (`durableTask`-typed task)
  in `@hogsend/engine`; `buildBucketRegistry`/`selectBucketTasks`/
  `registry-singleton`; `BucketId` union helper pattern in consumer constants.
- `bucket_memberships` (PARTIAL active unique index) + `bucket_configs`
  (`criteriaHash`) tables + enum + relations; generate `0011_*` migration
  (hand-verify the partial unique index SQL).
- `checkBucketMembership` inside `ingestEvent` (recursion guard; event+property
  candidate narrowing; cached `bucket_configs`; **merged-contact-state** property
  eval; read-after-write-safe count; diff with **RETURNING-gated** emission;
  `reentry` emit gate; `minDwell` deferred-leave; aliased-only emission default).
- `ENABLED_BUCKETS` env; `buckets?` option on `createHogsendClient`/`createWorker`;
  `create-hogsend` template parity (`src/buckets/` + wiring).
- Consumer `apps/api/src/buckets/` with one property-based example.
- **Acceptance (`app.request()` tests):** (1) an event satisfying a
  property/event-existence bucket creates one `active` row and emits
  `bucket:entered:<id>` exactly once; a follow-up flipping criteria false emits
  `bucket:left` once; stable membership emits nothing. (2) **Re-entrant cycle:**
  `join → leave → join → leave → join` (3 full cycles) produces three `left` rows +
  one `active` row with **no unique violation**, `entryCount` incrementing. (3) A
  triggering event that OMITS a referenced property still evaluates correctly
  against merged contact state (no spurious join/leave). (4) `reentry:"once"`
  suppresses the second `bucket:entered` while still writing the active row. (5) A
  `bucket:`-prefixed event short-circuits (no recursion). (6) A journey bound to
  `bucket:entered:<id>` enrolls; the test installs a known registry via
  `setBucketRegistry`/`resetBucketRegistry` and asserts on the
  `checkBucketMembership` transition list (no live Hatchet) — see Testing below.

### Phase 2 — Cron reconciliation for time-based leaves

- `bucketReconcileTask` (`onCrons`, self-bootstrapping, **non-cancelling**
  concurrency or per-bucket runs), registered in `baseWorkflows`.
- `timeBased` inference + **SHOULD-LEAVE query per criterion shape**
  (`not_exists`/`exists`/`count`) → bulk CAS transition → RETURNING-gated emit;
  `lastEvaluatedAt` chunking for composite-only buckets; EXPLAIN validation at
  scale.
- **Acceptance:** (1) a user matching `event ... within: days(7)` whose qualifying
  event ages out is transitioned to `left` and `bucket:left` emitted on the next
  tick **with no inbound event**. (2) **Count-decay:** a `power-users` member whose
  windowed count drops below the threshold as the window slides (no new event) is
  left by the cron (the `NOT EXISTS`-only shortcut would miss this). (3)
  **minDwell deferral:** a member whose criteria flip false during the dwell window
  who then goes silent STILL gets `bucket:left` after `minDwell` (not lost). (4)
  **Convergence:** the Section 6.3 worked example — concurrent ingest + cron tick —
  produces exactly one emission (byte-identical idempotencyKey). `onCrons` confirmed
  firing on hatchet-lite/Railway.

### Phase 3 — Backfill + fast-expiry + observability

- **Set-based** first-time backfill + **criteria-change re-eval** (full diff via
  `criteriaHash`) Hatchet jobs with a status record (`bucket_backfill_jobs` /
  `import_jobs`); first-time joins suppressed, criteria-change leaves emit.
- `bucketExpiryTask` for `fastExpiry` buckets + persisted `expiresAt` arming epoch;
  **CAS-gated** leave on wake.
- Admin `bucketsRouter` (list/detail/members/PATCH) + metrics endpoints + Studio
  Buckets view (size, enter/leave over time, feeds-journeys badges,
  enable/disable, building/live badge driven by the status record).
- **Acceptance:** defining a new bucket materializes existing members without
  firing live joins; editing criteria leaves now-non-matchers (emitting
  `bucket:left`) and joins new matchers (no emit); a `fastExpiry` bucket leaves near
  its deadline (sub-cron) and a re-armed window does NOT spuriously leave (CAS);
  Studio shows accurate size + trends + which journeys it feeds; enable/disable via
  PATCH toggles `bucket_configs` and propagates within the cache TTL.

### Phase 4 — Static/manual buckets + optional PostHog sync

- Manual membership via an admin endpoint / import (`kind:"manual"`, no criteria;
  `source:"manual"`), skipped by recompute (registry early-continue; cron skip).
- `syncToPostHog` person-property `$set` on join / `$unset` on leave; no-op without
  `POSTHOG_API_KEY`.
- **Acceptance:** manual add/remove emits `bucket:entered`/`bucket:left` and is
  never auto-recomputed; with `syncToPostHog` on, a join `$set`s
  `hogsend_bucket_<id> = true` on PostHog (verified against a PostHog cohort
  inlining the property).

### Testing (the unit-test seam)

Engine/consumer tests live in `apps/api/src/__tests__/` and call `app.request()`
against the Hono app (per CLAUDE.md). Buckets add a SECOND process singleton (the
bucket registry) plus a recursive-emit path, so the test seam is stated explicitly:

- **Install a known registry per test** with `setBucketRegistry(buildBucketRegistry
  ([...testBuckets], "*"))` in setup and `resetBucketRegistry()` in teardown — the
  bucket analog of how journey tests seed the journey registry. This isolates tests
  and avoids leaking buckets across cases.
- **Assert on the transition list, not Hatchet.** `checkBucketMembership` returns
  the computed `{ bucketId, transition }[]` specifically so a unit test can assert
  enter/leave/no-op WITHOUT a live Hatchet or worker. The recursion-guard test
  (Section 6.1 rule #1) and the convergence test (Section 6.3 worked example) target
  `checkBucketMembership` directly.
- The re-entrant-cycle, merged-property, `reentry`-suppression, count-decay, and
  minDwell-deferral acceptance tests above all run at this seam.

---

## 15. Open questions / decisions for Doug

0. **Boundary revision to ratify (NEW — the most important decision).** This spec
   openly **revises** the "Resolved" boundary in
   `docs/posthog-community-insights.md`, which literally assigns cohort computation
   AND absence detection to PostHog. The revision (Section 2.1): Hogsend computes
   membership off its OWN ingested `userEvents` stream in real time at any window
   length; PostHog keeps batch analytics cohorts and detection over events Hogsend
   does not ingest. **Ratify this boundary change**, and update
   `posthog-community-insights.md`'s "Resolved" section to point at it so the two
   docs do not silently disagree.
1. **Cron cadence default.** `*/5 * * * *` proposed for absence leaves. Is
   5-minute leave latency acceptable as the default? `fastExpiry`-on-by-default for
   ALL time-based buckets is **NOT** recommended — it would arm one durable timer
   per member of every time-based bucket (Section 6.5).
2. **`onCrons` on hatchet-lite/Railway.** No prior usage in the repo. OK to make
   Phase 2 contingent on a validation spike, with `fastExpiry` durable timers as
   the proven fallback for latency-critical buckets in the interim?
3. **Generic vs aliased events — RECOMMENDED: aliased-only by default.** The spec
   now defaults to emitting only `bucket:entered:<id>` (deriving the generic
   `bucket:entered` only when a generic-bound journey exists), halving every
   per-transition cost line (Section 8.5/13). Confirm this default over "always
   emit both".
4. **email_engagement in criteria — RESOLVED as flatly forbidden in v1.** Rejected
   at registration (enforceable), NOT gated on the unenforceable
   `email === externalId` check. Confirm; revisit when `ConditionContext` gains a
   distinct `email` field.
5. **Buckets-of-buckets + bucket-membership-as-condition (`in_bucket`).** Defer
   both to a later phase (new `ConditionEval` variant + topological ordering);
   v1 workaround is mirror-to-property-then-`PropertyCondition` (Section 5).
   Recommended: yes, defer.
6. **Backfill trigger + criteria-change semantics.** (a) Auto-enqueue backfill on
   first registration, or require an explicit admin "build" action? (Explicit is
   safer for large audiences.) (b) Confirm the asymmetric edit semantics:
   criteria-change LEAVES emit `bucket:left` (so journeys exit) while criteria-change
   JOINS do not emit (Section 6.6).
7. **`reentry` defaults.** Default `unlimited` (always emit on transition) vs
   `once_per_period` to be conservative about journey re-enrollment? (The gate is
   now actually implemented — Section 6.3.)
8. **PostHog sync key + leave op — RECOMMENDED: `$unset` on leave.** `$unset` and
   `$set false` are NOT interchangeable for cohort authors (Section 12); `$unset` is
   the recommended default. Confirm `hogsend_bucket_<id>` naming and `$unset`.
9. **Partial unique index in drizzle 0.45.2.** Confirm `.where(sql\`...\`)` emits the
   partial unique index, else hand-write it in the `0011_*` migration (Section 8.2).

---

## 16. Addressed review findings

This revision folded in the architecture review. Summary of dispositions:

**Blockers (all addressed):**
- Re-entrant membership unique-index violation → PARTIAL unique index on
  `(userId, bucketId) WHERE status='active' AND deleted_at IS NULL`; fresh active
  row per join; re-entrant acceptance test (Sections 8.2, 6.3, 14).
- Property buckets non-functional → property eval reads MERGED contact state
  (`{ ...contact.properties, ...event.properties }`); example fixed (Section 6.1).
- Cron per-member `evaluateCondition` = O(round-trips) → set-based SHOULD-LEAVE +
  bulk CAS; per-member path reserved for composite-only; non-cancelling concurrency
  (Section 6.4).
- `membershipEpoch`/idempotencyKey undefined → epoch = membership `entryCount`,
  read by all producers; emission gated on RETURNING; worked example (Section 6.3).
- Boundary contradiction (sub-24h vs `days(7)`/`days(30)` examples) → boundary is
  REAL-TIME vs BATCH, not window length; examples kept; revision named openly
  (Section 2).

**Majors (all addressed):** `reentry` gate implemented (`shouldEmitJoin`);
emission gated on the atomic mutation not a key race; count-decay SHOULD-LEAVE per
criterion shape; read-after-write transaction/`+1` rule; reserved `bucket:*` event
names rejected at registration; minDwell deferred-not-dropped; boundary revision
named + webhook-adapter contrast + anti-CDP invariant with teeth; per-transition
emission cost + aliased-only default; property index (real-time not O(N)); backfill
set-based + status record; GDPR cascade; criteria-change re-eval via `criteriaHash`;
manual-bucket `kind` discriminator now; `BucketId`-typed alias helpers;
`checkBucketMembership` signature self-consistent (`registry` threaded);
`bucket_configs` in-memory cache off the hot path; fastExpiry cardinality corrected
to O(membership); create-hogsend scaffold parity.

**Minors/nits (folded in):** `DefinedBucket.task` → `durableTask` type; `defineBucket`
pure passthrough (task synthesized in `selectBucketTasks`); fast-expiry CAS leave;
composite serial-eval ordering guidance; email_engagement flatly forbidden (drop
unenforceable wording); `in_bucket` deferral noted; PostHog `$unset` recommended +
`POSTHOG_API_KEY` no-op noted; real-time-cohort overclaim softened; naming leads
with "Buckets"; no-`suppress` note; backfill `import_jobs` precedent; `entryCount`
incremented on re-join; "safe backstop" scoped to timeBased; generic-binding cost
warning; EXPLAIN-validation step; Section 9.6 split minimal/optional + migration
step dropped; Testing seam documented.

**Declined / deferred (with reasons):**
- **`$set false` as an allowed leave op** — kept as an explicit non-default option
  (some authors want a sticky falsy value), but `$unset` is the recommended default.
  Not removed because it is occasionally legitimate.
- **Engine-side journey re-completion unique-index bug** — flagged to the lead as a
  separate pre-existing engine concern (Section 8.2 note); NOT fixed here because it
  is out of the buckets scope and touches `journey-states.ts` semantics.
- **Contact-deletion → `journeyStates` cascade** — flagged as a pre-existing gap
  (Section 8.6 note); buckets handle their own cascade, the journey gap is out of
  scope.
- **Parallelizing independent composite sub-conditions** — noted as a future
  optimization, explicitly out of v1 scope (serial eval with property-first ordering
  is the v1 guidance).
