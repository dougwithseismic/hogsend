# PRD 04 — `cohort-trigger-sugar`

**Depends on:** 02 (`posthog-cohort-sync` — binds a PostHog cohort to a `kind: "manual"`
bucket and gives that bucket a stable `id`). **Status:** `[-]` CUT 2026-07-28.

> **Cut, not deferred. This is not going to be built.** `trigger: { cohort: "some-name" }`
> is the magic string that started the review which ended in parking the cohort chain
> (`DECISIONS.md` §8): a reference to a thing declared in the consumer's own repo, passed
> as an unchecked name instead of the typed object. Its dependency, PRD 02, is parked on
> `parked/posthog-cohort-sync`, so there is no cohort-bound bucket for this sugar to name;
> and the decision is that the cohort trigger does not ship even if 02 is resumed.
>
> **Nothing is lost by cutting it.** The capability it wraps is already legal end-to-end
> with zero engine changes — `trigger: { event: "bucket:entered:<bucketId>" }` — because
> journey triggers are not subject to `RESERVED_EVENT_NAMESPACES` and `journeyMetaSchema`
> validates `trigger.event` as a bare string. That is verified below and remains true.
> This PRD only ever proposed sugar over it.
>
> **The document is kept deliberately**, for two findings worth more than the feature: the
> namespace verification below, and the `where`-scope misconception T04.4 was written to
> guard against.

## Goal

`defineJourney({ meta: { trigger: { cohort: "<bucketId>" } } })` desugars, at
`defineJourney` call time, to the exact same stored `JourneyMeta.trigger.event` a
hand-authored `{ event: "bucket:entered:<bucketId>" }` trigger produces today. Pure
ergonomic sugar over an existing, already-legal mechanism — not a new capability.

## Why this is sugar, not a new capability

Verified in recon: journey triggers are **not** subject to
`RESERVED_EVENT_NAMESPACES` (`packages/core/src/events.ts:8-23`) — that check gates only
Studio Blueprint triggers (`packages/engine/src/lib/blueprints.ts:114-135`,
`packages/engine/src/workflows/journey-blueprint-interpreter.ts:332-340`) and
semantic-link event names (`packages/engine/src/lib/tracking.ts:71`). `journeyMetaSchema`
(`packages/core/src/schemas/journey.schema.ts:91-94`) validates `trigger.event` as a bare
`z.string().min(1)`. A journey author can already write
`trigger: { event: "bucket:entered:power-users" }` today and it works, end to end, with
zero engine changes. **This PRD exists only to make that spelling nicer and to close the
one hole hand-authoring leaves open: a typo'd bucket id silently registers a journey bound
to an event nothing will ever emit.**

## Locked decisions

- **Boundary is authoring-time only.** `packages/core/src/types/journey.ts`
  (`JourneyMetaInput` — the authoring-facing type) gains the sugar; the **stored**
  `JourneyMeta` (`journey.schema.ts:85-148`, the registry/HTTP/Studio-facing shape) is
  **unchanged** — after `defineJourney` runs, a cohort-sugared journey and a
  hand-authored-event journey are byte-identical rows. This mirrors the existing
  `JourneyWhere` builder-fn precedent exactly (`journey.ts:12-40`): the builder form is
  authoring-only sugar, resolved ONCE into plain data before it ever reaches the registry.
- **The sugar targets a bucket id, not a raw PostHog cohort id.** A journey author thinks
  in terms of the Hogsend bucket a PRD-02 binding populates (`bucket.meta.id`), not
  PostHog's own cohort id — the bucket is the stable, Hogsend-native handle. `cohort:
  "power-users"` means "the bucket registered as `power-users`", exactly as
  `DefinedBucket.entered`/`.left` already compute (`packages/engine/src/buckets/define-bucket.ts:93-96`:
  `` `bucket:entered:${meta.id}` `` / `` `bucket:left:${meta.id}` ``).
- **Not restricted to `kind: "manual"` buckets.** [PROPOSED] The desugar is a pure string
  substitution against `bucket:entered:<id>` / (see below) — it has no dependency on how
  the bucket's membership is populated. Restricting it to cohort-backed manual buckets
  would add a kind-check with no correctness benefit and would block the equally valid
  case of triggering a journey off a `kind: "dynamic"` bucket's entry via the same sugar.
  Flagging this as a deviation from the PRD's name in case the reviewer wants it
  kind-restricted for clarity of intent; nothing in the codebase requires the restriction.
- **THE RISK, stated by the assigning brief: a cohort id with no corresponding registered
  bucket must fail LOUDLY at boot, never silently register a journey bound to an event
  nothing emits.** This is the whole reason this PRD is worth doing over telling authors
  to hand-write the event string. See "The boot-order problem" below — this is the part
  that does **not** fit inside the stated `define-journey.ts`-only boundary.
- **`where` on a cohort trigger filters the *transition event*, not cohort membership
  properties.** [PROPOSED — clarification, not yet decided by the assigning brief]
  `trigger.where` (via `JourneyWhereBuilder`, `journey.ts:12`) evaluates against the
  **triggering event's own properties** — for `bucket:entered:<id>`, that is exactly the
  bag `emitBucketTransition` constructs: `{ bucketId, bucketName, userId, transition,
  source, entryCount }` (`packages/engine/src/lib/bucket-emit.ts:105-114`; `reason` is
  added only for `left`, `bucket-emit.ts:116-118`). **It does NOT include the member's
  PostHog/contact properties** (plan, score, whatever the cohort itself filters on) —
  those never ride the transition event. An author writing
  `trigger: { cohort: "power-users", where: (b) => b.prop("plan").eq("pro") }` expecting
  to further filter cohort members by plan will get a `where` clause that silently never
  matches (no event ever carries a `plan` property), not an error — this is exactly the
  "vacuous, not loud" failure mode this stack is trying to avoid elsewhere (DECISIONS
  §2.6, `feedback_vacuous-green-tests`). Cohort *definition* → bucket *criteria*
  translation is explicitly out of scope (DECISIONS §3.1), so this PRD cannot fix the
  underlying gap — it can only make sure the sugar's docs/types don't imply `where` does
  something it cannot do. Task T04.4 below addresses this with a documentation/type-level
  guard, not a runtime one (a runtime block on "any `where`" is not proposed here since
  filtering on `source`/`entryCount`/leave `reason` is legitimate and works).

## The boot-order problem (read before touching `define-journey.ts` alone)

`defineJourney()` runs at **module load time** — when the consumer's journey file is
imported, well before `createHogsendClient()` is ever called (the resulting
`{ meta, run, task }` objects are collected into an array and handed to
`createHogsendClient({ journeys: [...] })` as a plain argument). At that point **no
bucket registry exists yet** — `getBucketRegistrySingleton()`
(`packages/engine/src/buckets/registry-singleton.ts`) is a `createSingleton` that is only
populated by `buildBucketRegistry` inside `createHogsendClient`
(`packages/engine/src/container.ts:859`), and — load-bearing detail —
`buildJourneyRegistry` runs at `container.ts:850`, **before** `buildBucketRegistry` at
`container.ts:859`, in the SAME function. So there is no point inside `define-journey.ts`
itself, and no point in `buildJourneyRegistry`, where a bucket-existence check can run: the
bucket registry the check needs is built one line later, in the same synchronous call.

**Consequence: "fail loudly at boot" cannot be implemented inside the stated boundary
alone.** It requires one additional, small cross-check in `packages/engine/src/container.ts`,
placed after `buildBucketRegistry` (after `container.ts:859`), which is **outside** the
`packages/core/src/types/journey.ts` + `packages/engine/src/journeys/define-journey.ts`
boundary given for this PRD. [PROPOSED] Task T04.3 below adds this as its own task with
that boundary named explicitly, rather than silently widening T04.1/T04.2's stated scope.
If the reviewer wants the boundary held strictly to the two originally-named files, the
validation must instead move to `createApp`/`createWorker`'s shared boot path or be
accepted as a documented gap (an unregistered-bucket cohort trigger would then only surface
as "the journey silently never fires" — the exact outcome this PRD exists to prevent).

**The validation is deliberately general, not cohort-sugar-specific**, because a
hand-authored `{ event: "bucket:entered:<typo'd-id>" }` trigger has **exactly the same
silent-dead-journey failure mode today**, with zero protection, and this PRD's own sugar
desugars to that identical string shape. [PROPOSED] The check: for every registered
journey (from `registry.getAll()`, `packages/core/src/registry/index.ts`) whose
`trigger.event` matches `/^bucket:(?:entered|left):(.+)$/`, the captured bucket id must
satisfy `bucketRegistry.has(id)`, else throw at boot with the journey id, the offending
event string, and the list of registered bucket ids (mirroring the "did you mean"
ergonomics already shipped for `ENABLED_JOURNEYS` typos, `packages/engine/src/journeys/registry.ts`
`levenshtein`/`resolveEnabledFilter`). This protects both the new sugar AND every
hand-authored bucket-event trigger already legal today — net new safety, not sugar-only
safety.

## Acceptance criteria (EARS)

1. WHEN a journey is authored with `trigger: { cohort: "<id>" }`, the system SHALL store
   `JourneyMeta.trigger.event` as `` `bucket:entered:<id>` `` and SHALL NOT add any new
   field to the stored `JourneyMeta` shape.
2. WHEN a journey is authored with `trigger: { cohort: "<id>", where: <JourneyWhere> }`,
   the system SHALL normalize `where` through the existing builder-resolution path
   (`normalizeWhere`, exactly as the `event` trigger form does) with no divergent
   behavior.
3. WHEN both `event` and `cohort` are supplied on the same `trigger` object, the system
   SHALL reject it at author time as a type-level error (mutually exclusive), not a
   runtime throw.
4. WHEN a journey's registered trigger event matches `bucket:(entered|left):<id>` and `id`
   is not a registered bucket at the point both the journey and bucket registries have
   finished building, the system SHALL throw at boot, naming the journey id, the
   unresolved bucket id, and the full list of registered bucket ids.
5. WHEN a journey's cohort-sugared bucket id IS registered, boot SHALL succeed and the
   journey SHALL enroll exactly as a hand-authored `bucket:entered:<id>` trigger would.
6. WHEN a `bucket:left:<id>` hand-authored trigger references an unregistered bucket, the
   same AC-4 boot check SHALL catch it (the validation is symmetric across
   entered/left, not cohort-sugar-exclusive).
7. WHEN no PostHog credential is configured and no cohort sync (PRD 02) is wired up, a
   journey using cohort-trigger sugar against a bucket that IS registered (e.g. a
   `kind: "dynamic"` bucket, or a `kind: "manual"` bucket populated by PRD 01's direct
   write path) SHALL still boot and enroll normally — the sugar has no PostHog
   dependency of its own.

## Tasks

### T04.1 — `JourneyMetaInput.trigger` gains the `cohort` variant
_Boundary:_ `packages/core/src/types/journey.ts` · _Depends:_ —

Widen `JourneyMetaInput["trigger"]` (currently `{ event: string; where?: JourneyWhere }`,
`journey.ts:29-35`) to a discriminated union:
`{ event: string; where?: JourneyWhere } | { cohort: string; where?: JourneyWhere }`.
Satisfies AC 3 (mutual exclusivity is a TypeScript union, not a runtime check — supplying
both `event` and `cohort` is simply not a valid literal of either arm). `JourneyMeta`
itself (the stored shape, `journey.schema.ts:85-94`) is untouched.

### T04.2 — Desugar in `defineJourney`
_Boundary:_ `packages/engine/src/journeys/define-journey.ts` · _Depends:_ T04.1

At the same point `trigger.where` is already resolved (`define-journey.ts` — the
`normalizeWhere(trigger.where)` call inside the current `trigger` destructure), branch on
`"cohort" in trigger`: when present, set `event: \`bucket:entered:${trigger.cohort}\`` —
reuse the exact same template literal shape `DefinedBucket.entered` computes
(`define-bucket.ts:95`), do not hand-roll a second copy of the `bucket:entered:` prefix
string. `where` normalization is unchanged either way. Satisfies AC 1, 2, 5.

### T04.3 — Boot-time bucket-existence validation
_Boundary:_ `packages/engine/src/container.ts` (flagged as outside the PRD's originally
stated boundary — see "The boot-order problem" above; requires reviewer sign-off to
widen) · _Depends:_ T04.2

Add a validation pass after `buildBucketRegistry` (`container.ts:859`) and before
`createHogsendClient` returns, walking `registry.getAll()` for any `trigger.event`
matching `/^bucket:(?:entered|left):(.+)$/` and asserting `bucketRegistry.has(capturedId)`.
Throw with journey id + event + registered-bucket-id list on a miss. Satisfies AC 4, 6.
This check is deliberately NOT scoped to cohort-sugared journeys only — see rationale
above.

### T04.4 — Documentation guard against the `where`-scope misconception
_Boundary:_ `packages/core/src/types/journey.ts` (JSDoc on the new `cohort` trigger
variant) + `packages/cli/skills/hogsend-authoring-buckets` (if the reviewer judges the
authoring skill in scope) · _Depends:_ T04.1

Document, at the type level, that `where` on a `cohort` trigger evaluates against the
bucket-transition event's own properties (`bucketId`, `bucketName`, `userId`,
`transition`, `source`, `entryCount`, and `reason` on leave) and NEVER against the
member's PostHog/contact properties — cohort *definition* to bucket *criteria*
translation is out of scope (DECISIONS §3.1). No runtime behavior change; purely closes
the documentation gap identified above so this doesn't ship as a silent footgun.

## Seams

None — this PRD is fully self-contained in-repo and has no PostHog-credential dependency
of its own (it only requires PRD 02 to exist so there is a bucket worth sugaring the
trigger for; the sugar itself works against any registered bucket, PostHog-backed or not).

## Done when

All ACs pass, gates green, and: (a) a journey authored with
`trigger: { cohort: "power-users" }` against a registered `power-users` bucket enrolls
identically to a hand-authored `trigger: { event: "bucket:entered:power-users" }` journey,
and (b) a deliberately-misspelled `trigger: { cohort: "power-usres" }` (or the equivalent
hand-authored `bucket:entered:power-usres` event) throws at boot, naming the typo and the
real registered bucket ids, rather than registering a journey that will never fire.

## Implementation Notes
