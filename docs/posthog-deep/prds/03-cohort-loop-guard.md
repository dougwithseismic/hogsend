# PRD 03 — `cohort-loop-guard`

**Depends on:** 02. **Ships in the same release as 02.** **Status:** `[ ]`

## Goal

Make the property-writeback feedback loop structurally impossible rather than merely
documented.

## Why this is not optional and not deferrable

`packages/engine/src/lib/bucket-posthog-sync.ts` **already** writes `hogsend_bucket_<id>`
to PostHog persons on join (shipped, off by default per bucket). Combined with PRD 02's
cohort import, the loop closes with no new code:

1. Bucket A with `syncToPostHog: true` sets `hogsend_bucket_a: true` on PostHog persons.
2. An operator defines a PostHog cohort filtering on `hogsend_bucket_a`.
3. PRD 02 polls that cohort into manual bucket B and emits `bucket:entered:B`.
4. A journey fires and writes a person property. The cycle closes and oscillates on every
   poll, forever.

The single-hop case is not self-limiting either: a journey triggered by cohort entry that
calls `setPersonProperties` can re-qualify the very cohort that triggered it.

**The existing guard does not catch this.** The `bucket:*` recursion guard
(`check-membership.ts:105-108`) only bounds recursion that stays inside Hogsend; the
PostHog round-trip launders the event, re-entering as a poll result rather than a
`bucket:`-prefixed ingest.

**The existing anti-flap does not catch it either.** `minDwell` debounces oscillation
(join→leave→join), not amplification across N distinct buckets, each of which is
individually well-behaved. `entryLimit: "once"` bounds one bucket, not the chain.

**It is a *slow* oscillator**, bounded by PostHog's ~hourly cohort recompute plus the poll
interval. That is worse operationally, not better: it evades every fast-loop alarm and
surfaces as a mystery drip of sends over days.

"Operators won't do that" is not available as a defence. PRD 07 and PRD 09 explicitly
instruct them to build the other half.

## Locked decisions

Four layers, in order of how much they are relied upon.

1. **Provenance segregation, enforced at binding activation and re-checked every tick.**
   Refuse, loudly, to bind a cohort whose definition references any person-property key
   Hogsend can write. Direct analogue of the shipped invariant refusing `bucket:*` event
   names in bucket criteria (`packages/core/src/schemas/bucket.schema.ts:143-152`).
   Requires reading the cohort *definition*, which `cohort:read` already grants.
   - **The check walks nested cohort references** (cohort A referencing cohort B which
     references a Hogsend-written key).
   - **It fails closed** when a nested cohort cannot be resolved, naming the unreadable
     cohort in the error. This will occasionally block a legitimate binding. That is the
     correct trade.
   - **It keys off a PROVENANCE REGISTRY, not the `hogsend_*` prefix** (DECISIONS §2.5).
     See the threat model below — a static prefix check is evadable with documented
     features and no ill intent.
   - **It does NOT run at boot** (DECISIONS §2.5, §2.1). See "Where the guard lives" below.
2. **Write-suppression on cohort-sourced membership.** A transition whose membership row
   has a cohort/manual `source` does not fire `syncBucketToPostHog`. Today the mirror is
   unconditional (`bucket-emit.ts:143-146`). Breaks the most obvious one-hop loop outright.
3. **A per-contact, per-window person-write fuse.** Writes beyond N per contact per hour
   are dropped and logged. Not a fix — a numeric backstop for a semantic guard that a
   nested cohort can defeat.
4. **A metric** on cohort-sourced joins per bucket per tick, alarmed on step change. The
   oscillation is slow; a graph is the only way it gets caught.

Precedent: `ingestEvent` already excludes `source === "posthog"` from the analytics mirror
as an anti-loop measure (`ingestion.ts:478-520`). This PRD extends an existing instinct.

## Threat model: why a `hogsend_*` prefix check is not the guard

State it explicitly, because the naive implementation looks correct and is not. The prefix
check assumes every person property Hogsend writes begins with `hogsend_`. Two documented,
supported features break that assumption, neither requiring ill intent:

1. **A bucket with a custom `postHogPropertyKey`.** The operator names the mirrored
   property whatever they like. A cohort filtering on that name references a
   Hogsend-written key while passing a prefix check cleanly.
2. **One line of `getPostHog()?.identify()` inside a cohort-triggered journey.** A journey
   entered via `bucket:entered:<id>` sets an arbitrary person property; a cohort filters on
   it; the cohort feeds the bucket. That is a two-hop loop that passes binding validation,
   evades write-suppression (layer 2 gates the *mirror*, not arbitrary journey writes), and
   sits under the fuse (layer 3) because it is one write per enrollment.

**Locked: the check keys off a provenance registry of every person-property key Hogsend can
write.** The registry covers, at minimum:

- the default `hogsend_bucket_<id>` for every bucket in the registry;
- every configured `postHogPropertyKey` across the bucket registry;
- PRD 07's engagement-writeback keys.

**And the registry is closed, not best-effort.** Engine-originated person writes are
**namespace-forced**: a `setPersonProperties` key outside the reserved namespace is
rejected or prefixed at the write site. Without that, the registry is a list of keys we
happen to know about, and case 2 above stays open forever. With it, "a key Hogsend can
write" and "a key in the reserved namespace" are the same set by construction, and the
walker's answer is sound rather than probabilistic.

## Where the guard lives — NOT the boot path

The obvious home is boot validation, next to the other registration-time invariants. It is
**unbuildable there**, and would violate DECISIONS §2.1 if it were:

- **The boot path is synchronous.** The definition walk needs a live, paged, rate-limited
  PostHog fetch that also follows nested cohort references. There is no synchronous seam
  for that.
- **A live PostHog fetch at boot makes a PostHog outage take down every API and worker
  boot** — the precise "PostHog is never load-bearing" failure DECISIONS §2.1 forbids. An
  expired token would do the same.
- **Making `createHogsendClient`/`createApp`/`createWorker` async** to accommodate it is a
  breaking change to the committed public API surface, budgeted nowhere in this stack.

**Locked: the guard lives on the data plane.**

- **At binding activation** — the async admin/CLI operation of PRD 02 T02.2, which *can*
  fail the bind and report why.
- **Re-verified at the head of every sync tick.** Not optional: cohort definitions are
  mutable upstream. An operator binds a clean cohort, later adds a `hogsend_bucket_a`
  filter in the PostHog UI (which PRD 07 actively encourages), and a bind-time-only check
  never re-runs until the next redeploy. Fold the definition read into PRD 02's cheap LIST
  check, which already hits the endpoint each tick and whose response carries the cohort's
  filters — so re-walking is close to free.
- **A fail-closed result disables THAT BINDING** — quarantined: stop syncing it, emit no
  transitions and specifically **no leaves** (a quarantine is not an observation, so §2.6's
  rule applies), loud operator-facing error, admin surface, metric. **Never the process.**

## Open question for the build

**Is `syncToPostHog` already unsafe on its own today, independent of anything here?** A
bucket whose own criteria depend on a property that the mirror writes could already
self-sustain. If T03.0 confirms it, that is a live bug in shipped code and is fixed in
this PRD.

## Acceptance criteria (EARS)

1. WHEN a cohort binding is **activated** and the cohort definition references any key in
   the provenance registry, the system SHALL refuse the binding and SHALL name the
   offending property. Refusal happens at binding activation (async), never at process
   boot.
1a. WHEN a bucket declares a custom `postHogPropertyKey`, that key SHALL be in the
   provenance registry, and a cohort filtering on it SHALL be refused exactly as
   `hogsend_bucket_<id>` is. A prefix-only check SHALL NOT be sufficient to pass this AC —
   mutation-test it with a custom-keyed bucket.
1b. WHEN engine code writes a person property via `setPersonProperties`, the system SHALL
   namespace-force the key — rejecting or prefixing anything outside the reserved
   namespace — so the provenance registry is closed by construction rather than
   best-effort.
2. WHEN a cohort definition references a nested cohort, the system SHALL walk the
   reference and apply AC 1 transitively.
3. WHEN a nested cohort reference cannot be resolved, the system SHALL refuse the binding
   and SHALL name the unreadable cohort.
3a. WHEN a sync tick runs for an active binding, the system SHALL RE-RUN the definition
   walk for that tick — folded into PRD 02's cheap LIST check — and SHALL NOT rely on the
   bind-time result.
3b. WHEN a re-walk detects that a bound cohort's definition has drifted to reference a
   registry key, the system SHALL quarantine that binding: stop syncing it, emit no
   transitions and specifically **no leaves**, and surface a loud operator-facing error.
   The process SHALL NOT fail and other bindings SHALL be unaffected.
3c. WHEN the guard fails closed for any reason, the failure SHALL disable that single
   binding only, and SHALL NEVER prevent `createHogsendClient`/`createApp`/`createWorker`
   from completing.
4. WHEN a bucket transition originates from cohort-sourced membership, the system SHALL
   NOT fire `syncBucketToPostHog`.
5. WHEN a bucket transition originates from criteria evaluation, the existing
   `syncToPostHog` behaviour SHALL be unchanged.
6. WHEN person-property writes for one contact exceed the configured window budget, the
   system SHALL drop further writes and SHALL log the drop with the contact key.
7. WHEN cohort-sourced joins occur, the system SHALL emit a per-bucket per-tick metric.

## Tasks

### T03.0 — Determine whether `syncToPostHog` is already unsafe
_Boundary:_ investigation, no production code · _Depends:_ —

Construct the self-sustaining case against the existing shipped feature. If reproducible,
file it and fix it here. Report the finding either way — it is independently useful.

### T03.1a — The provenance registry + namespace-forcing
_Boundary:_ `packages/core` + `packages/engine/src/lib/` · _Depends:_ —

Build the set of person-property keys Hogsend can write: default `hogsend_bucket_<id>` per
registered bucket, every configured `postHogPropertyKey` across the bucket registry, and
PRD 07's writeback keys. Then **close it**: namespace-force engine-originated person
writes so a `setPersonProperties` key outside the reserved namespace is rejected or
prefixed at the write site (AC 1b). Without the forcing leg, the registry is a best-effort
list and the one-line-`identify()` evasion in the threat model stays open.

Satisfies AC 1a, 1b. Mutation-test with a custom-`postHogPropertyKey` bucket — a walker
test that still passes against a plain `hogsend_*` prefix check is vacuous.

### T03.1 — Cohort definition reader + provenance walker
_Boundary:_ `packages/plugin-posthog` · _Depends:_ PRD 02 T02.1, T03.1a

Read the cohort's filter groups, walk nested cohort references with a bounded hop limit
(follow the 8-hop precedent in `contacts.ts:346-373`), detect any reference to a key in
the provenance registry — **not** a `hogsend_*` prefix match. Fail closed on an
unresolvable reference. Satisfies AC 1, 2, 3.

Expose it in the shape PRD 02's cheap LIST check can call per tick (AC 3a): the LIST
response already carries the cohort's filters, so the common-case re-walk should need no
extra request.

### T03.2 — Binding-activation refusal + per-tick re-verification
_Boundary:_ `packages/engine` binding activation (PRD 02 T02.2's async surface) +
`packages/engine/src/workflows/` (PRD 02 T02.4's tick head) · _Depends:_ T03.1

**Explicitly NOT boot validation.** The boot path is synchronous and a live PostHog fetch
there would make a PostHog outage take down every API and worker boot — DECISIONS §2.1's
forbidden failure mode — and making the factories async is a breaking public-API change
budgeted nowhere.

Two enforcement points:

- **Binding activation** (async, can fail the bind): refuse with an error naming the
  offending property or the unreadable cohort. Satisfies AC 1, 2, 3.
- **The head of every sync tick**: re-run the walk, folded into PRD 02's cheap LIST check.
  On drift, quarantine that binding — stop syncing, emit no transitions, emit **no leaves**,
  loud operator-facing error, admin surface, metric. Other bindings and the process are
  unaffected. Satisfies AC 3a, 3b, 3c.

Test with the Fake: bind a clean cohort successfully, mutate the Fake's definition to
reference a registry key, run another tick, assert the binding is quarantined and zero
transitions were emitted. A bind-time-only implementation passes the bind test and fails
this one — which is the point.

### T03.3 — Source-gate the PostHog mirror
_Boundary:_ `packages/engine/src/lib/bucket-emit.ts` + `bucket-posthog-sync.ts` ·
_Depends:_ —

Gate the currently-unconditional mirror call on membership `source`. Satisfies AC 4, 5.
Mutation-test: a test that passes with the gate removed is a vacuous test.

### T03.4 — Person-write fuse + metric
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ T03.3

Per-contact per-window budget with logged drops, plus the cohort-sourced-join metric.
Satisfies AC 6, 7.

## Seams

Verifying the *absence* of a slow oscillation cannot be done in a test suite in real time.
Build a deterministic simulation harness that drives N synthetic poll ticks against the
Fake and asserts transition counts converge rather than grow. Enumerate a real-project
soak as a human verification step before PRD 10 is ever considered.

## Done when

All ACs pass, gates green, and:

- the simulation harness demonstrates that a deliberately constructed two-hop loop
  configuration is **refused at binding activation** rather than merely surviving at
  runtime — including the custom-`postHogPropertyKey` variant, which a prefix check misses;
- a binding that was clean at bind time and drifts afterwards is **quarantined on the next
  tick**, with zero transitions and zero leaves emitted;
- a PostHog outage during boot does not prevent `createApp`/`createWorker` from starting.

## Implementation Notes
