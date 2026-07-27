# PRD 02 — `posthog-cohort-sync`

**Depends on:** 00, 01. **Ships with:** 03. **Status:** `[ ]`

## Goal

Poll PostHog cohorts on an independent cadence, diff the observed member set against stored
membership, and drive joins and leaves through PRD 01's `addBucketMember` /
`removeBucketMember` into a `kind: "manual"` bucket.

This is the headline feature: a PostHog cohort drives a TypeScript journey.

## Locked decisions

- **The poller routes every join and leave through PRD 01's `addBucketMember` /
  `removeBucketMember`, and calls `emitBucketTransition` NEVER** (DECISIONS §2.7).
  `emitBucketTransition` (`bucket-emit.ts:33`) **only emits** — it takes `epoch` as an
  input and never touches `bucket_memberships`; every existing producer writes the row
  itself and *then* calls it. A poller that "only emits and never writes" would leave
  nothing written to diff against, no source for `epoch` (so the deterministic idempotency
  key `bucket:<id>:<user>:<kind>:<epoch>` cannot be computed), and would therefore re-emit
  a join for every member on every tick, forever — the exact mass-emission failure this
  PRD exists to prevent. Routing through PRD 01 is how this PRD inherits epoch,
  `entryLimit`, `minDwell` deferral, the `contactId` provenance pin, and outbound catalog
  emission **for free** rather than reimplementing them.
- **A failed observation is not an empty cohort** (DECISIONS §2.6). Any page failure
  aborts the whole diff. Leaves are never emitted from a partial read. A cohort that is
  **gone** (404/403/410) is failed-to-observe, not empty.
- **The diff is computed on PostHog `person_id`, not on resolved contacts**
  (DECISIONS §2.6). Identity resolution is needed only for the *join* leg and can never
  subtract from the observed set.
- **First observation seeds without emitting** (DECISIONS §2.7a). Binding a cohort must
  not enroll its existing population.
- **Slow reconciler, not the fast path** (DECISIONS §2.4). Independent configurable
  cadence, not the 5-minute bucket-reconcile cron. A new workflow task, not
  `bucketReconcileTask`.
- **Membership only.** Cohort *definition* translation into bucket criteria is an explicit
  non-goal (DECISIONS §3.1). This is the single decision that keeps this PRD shippable in
  weeks rather than quarters.
- Anonymous-only members are imported for size fidelity. Existing preference and channel
  gates already no-op them.

## The failure mode this PRD exists to avoid

Every existing PostHog call soft-fails to `{}` (`properties.ts:173-175`). That idiom is
correct for person-property reads and **catastrophic** here: an empty member list reads as
*"every member left"*, producing a mass `bucket:left` emission, mass journey exits, and
every leave-reaction firing at once.

Writing this the obvious way, by reusing the house idiom, produces the catastrophe. **The
first test written in this PRD is the one that proves a failed page aborts the diff.**

The narrow transport rule is not sufficient on its own — the same catastrophe is reachable
by two further routes, both of which leave PostHog looking healthy the whole time
(DECISIONS §2.6):

- **A cohort that is gone is not a cohort that is empty.** Someone deletes, renames, or
  permission-revokes the cohort in the PostHog UI — routine housekeeping to a PostHog
  admin. A 404/403/410 must be failed-to-observe, never an empty result set.
- **Identity-resolution failure must not manufacture leaves.** If the diff compares
  *resolved contacts*, a resolver outage during one tick makes every member look absent and
  emits `bucket:left` for all of them. PostHog never errors, so the page-failure abort never
  fires, and the incident presents as a mystery mass-exit. Hence the diff is computed on
  **PostHog `person_id`**, and the abort predicate is "the observation is incomplete" —
  which explicitly includes "the resolver threw" — not merely "a page failed".

## Seeding: binding a cohort must not enroll its existing population

The engine already settled this for dynamic buckets. `bucket-backfill.ts:56-66`
materializes the existing matching population with `source: "backfill"` and explicitly
suppresses join emission — *"historical matches must not fire `bucket:entered` into live
journeys — the Customer.io rule"* — and `enqueueBucketBackfills` applies it to every newly
registered dynamic bucket. This PRD inherits that rule (DECISIONS §2.7a).

Without it, binding a 40k-member cohort to try the headline feature sends 40k emails in one
burst, irreversibly, as the first thing every new user does. Note also the internal
inconsistency this closes: PRD 06 makes an *operator-invoked* historical replay dry-run by
default, while this automatic cron path would otherwise act on a larger historical
population with no guard at all.

## Scale bounds

Napkin: a 2M-member cohort pages at ~100/page = ~20k requests per full pull, against
PostHog limits in the region of 240/min. Full-list-diff does not scale past low tens of
thousands.

- **Cheap-check before expensive pull.** The cohort LIST endpoint returns
  `last_calculation` and `count` per cohort. Poll the cheap list; only pay for the full
  `/persons/` dump when `last_calculation` has advanced. In the common case — dynamic
  cohorts recalculate roughly every 24h server-side — most ticks skip the dump entirely.
- **Rate limits are per-organization and shared with the customer's own PostHog usage.**
  Analytics endpoints: 240/min, 1200/hr. A full pull competes with everything else their
  team does against PostHog. Budget conservatively.
- `maxCohortSize` (default 100k) refuses a larger cohort with a clear error, rather than
  discovering the limit in production.
- A resumable page cursor persists in `import_jobs` so a rate-limited pull continues next
  tick instead of restarting. **`import_jobs` has no cursor or metadata column today**
  (`packages/db/src/schema/import-jobs.ts:12-26` — only `fileName`/`format`/`status`/
  `totalRows`/`processedRows`/`failedRows`/`errors`), so AC 6 is unsatisfiable until
  T02.0 adds one.
- Reuse `createRateLimitedFetch` — it already handles spacing, 429s, `Retry-After`, and
  exponential backoff. Do not reimplement. **It must move first**: it currently lives in
  `packages/cli/src/lib/import-shared.ts:96-148`, and neither `plugin-posthog` nor
  `engine` may import from `@hogsend/cli` (a workspace dependency cycle). DECISIONS §2.10
  locks a prerequisite task moving it into `@hogsend/core` with `packages/cli`
  re-exporting for back-compat; T02.1 depends on it.

## Acceptance criteria (EARS)

1. WHEN a cohort is bound to a manual bucket and the poll observes members not currently
   in the bucket, the system SHALL add them via PRD 01's `addBucketMember`, subject to
   `entryLimit`.
2. WHEN the poll observes that a current member is no longer in the cohort, the system
   SHALL remove them via PRD 01's `removeBucketMember`, subject to `minDwell` deferral.
2a. WHEN the sync applies any transition, it SHALL do so exclusively through
   `addBucketMember`/`removeBucketMember` and SHALL call `emitBucketTransition` zero
   times. Mutation-test: a test asserting transition counts that still passes when the
   membership write is deleted is vacuous — assert the `bucket_memberships` row exists
   with the expected epoch.
3. WHEN **any** page of a cohort pull fails, the system SHALL abort the entire diff, emit
   no transitions at all, log the failure, and retry on the next tick.
3a. WHEN the observation is incomplete for **any** reason — a page failed, a page returned
   a malformed body, the cheap LIST check did not confirm the cohort, **or the identity
   resolver threw** — the system SHALL abort the entire diff and emit no transitions. The
   abort predicate is "the observation is incomplete", not "a page failed".
3b. WHEN a bound cohort returns 404, 403, or 410, the system SHALL treat it as
   failed-to-observe: emit nothing, mark the binding **degraded**, surface a named error
   (not a generic fetch failure), and after N consecutive such failures stop retrying and
   escalate rather than failing silently forever.
3c. WHEN the sync is about to interpret a `/persons/` result as authoritative, the cheap
   LIST poll SHALL first have confirmed the cohort id is still present. A `/persons/`
   result unaccompanied by that confirmation SHALL NOT drive leaves.
3d. WHEN a binding is **removed**, the system SHALL keep existing members, emit **no**
   leaves, and mark the binding inactive.
4. WHEN a cohort is successfully observed to be genuinely empty — a completed, confirmed
   observation — the system SHALL emit leaves for all current members, distinguishably
   from AC 3/3a/3b.
5. WHEN a cohort exceeds `maxCohortSize`, the system SHALL refuse to sync it and SHALL
   report which cohort and what the limit is.
6. WHEN a pull is interrupted by rate limiting, the system SHALL persist a resumable
   cursor in `import_jobs` and continue from it on the next tick. (Requires T02.0's
   column — no such column exists today.)
7. WHEN a cohort member cannot be resolved to a Hogsend contact, the system SHALL count it
   as unresolved and SHALL NOT treat it as a leave for anyone — neither for itself nor for
   any other member. Its `person_id` still participates in the observed set.
8. WHEN a poll runs twice over an unchanged cohort, the second run SHALL emit no
   transitions.
9. WHEN no PostHog credential is configured, the sync SHALL be an inert no-op.
10. WHEN the bound bucket is not `kind: "manual"`, the system SHALL refuse the binding **at
    binding activation** — the async admin/CLI operation or the sync workflow's first tick —
    and SHALL NOT rely on a synchronous registration-time check.
11. WHEN membership is diffed, the system SHALL diff on PostHog `person_id`, and SHALL
    persist the source `person_id` on the membership row at join (a column, or the existing
    `bucket_memberships.context` jsonb). A resolver outage SHALL NOT be able to subtract a
    member from the observed set.
12. WHEN a binding is observed for the **first time**, the system SHALL materialize
    membership rows with a seed source via PRD 01's non-emitting bulk/seed path and SHALL
    emit **no** transitions. Only observations subsequent to the seed SHALL emit.
    Mutation-test this — a seed test that still passes with the suppression removed is
    vacuous.
13. WHEN a binding sets `emitOnSeed: true`, the system SHALL emit joins for the seed
    population, subject to every other gate.
14. WHEN the transitions computed for a single tick exceed the configured per-tick cap,
    the system SHALL abort that tick, emit nothing, and alert — rather than applying a
    partial burst.
15. WHEN an operator previews a binding before its first real tick, the system SHALL report
    "would emit N joins" without emitting anything.
16. WHEN the diff engine resolves a member, it SHALL use PRD 00's find-only
    `lookupPostHogPerson` for the diff itself, and SHALL create a contact via
    `resolvePostHogPerson` only for members carrying an email; anonymous-only members
    SHALL be recorded unresolved. Contacts created per tick SHALL be bounded and the count
    reported.

## Tasks

### T02.0 — `import_jobs` cursor/metadata column (+ binding table)
_Boundary:_ `packages/db` · _Depends:_ —

`import_jobs` (`packages/db/src/schema/import-jobs.ts:12-26`) has **no cursor and no
metadata column** — AC 6 is unsatisfiable without one, and PRD 06 needs the same thing.
Add a resumable-cursor/metadata column (a `jsonb` bag is the low-risk shape: page cursor,
bound cohort id, `last_calculation` watermark, consecutive-failure count, degraded flag).
If T02.2 chooses a separate binding table over a `BucketMeta` field, that table is owned by
this task too.

Generate with `pnpm db:generate`; do not hand-write SQL. Check partial-unique/arbiter
semantics against `reference_drizzle-partial-index-onconflict` (arbiter predicate is
`where`; 23505 walks `err.cause`). Coordinate with PRD 00 T00.1 — if that task hoisted the
`import_jobs` column already (its migration-batching note), this task adds only the binding
table. Do not add the column twice.

### T02.1 — Cohort client
_Boundary:_ `packages/plugin-posthog` · _Depends:_ `createRateLimitedFetch` → `@hogsend/core`
(the DECISIONS §2.10 prerequisite; see BACKLOG)

Paginating, rate-limited reads of cohort membership and cohort *definition* (the latter is
consumed by PRD 03). Hand-rolled `fetch` — `posthog-node` v5.35.1 has zero cohort support
(verified). Mirror the credential resolution in `properties.ts`: OAuth preferred,
degrading to personal key, private-vs-ingestion host derivation, project-id discovery.

**This client must NOT adopt the house soft-fail-to-`{}` idiom.** It returns a
discriminated result distinguishing observed-empty from failed-to-observe. That
distinction is the whole PRD. 404/403/410 are their own named variant, not a generic
failure and never an empty set (AC 3b). Expose the cheap LIST call
(`last_calculation`, `count`, cohort presence) as a first-class operation — AC 3c makes it
a precondition of interpreting `/persons/`, and PRD 03's per-tick re-walk folds into it.

### T02.2 — Cohort↔bucket binding
_Boundary:_ `packages/core` (+ `packages/engine` binding surface) · _Depends:_ T02.0

A binding record linking a cohort id to a manual bucket. **The binding is created through
an ASYNC surface — an admin route or the sync workflow's first tick — not as a field on a
synchronously-parsed `BucketMeta`.** Validation needs a live PostHog read (cohort exists,
is readable, and — PRD 03 — its definition is clean), which a synchronous Zod
`superRefine` at registration cannot perform, and which must never run on the boot path
(DECISIONS §2.1, §2.5).

So the "bound bucket must be `kind: "manual"`" rule (AC 10) is **refused at binding
activation**, not at registration. A `cohortId` field on `BucketMeta` may still exist as
*declared intent*; activation is what validates it. Binding carries `emitOnSeed` (default
`false`, AC 13) and the per-tick transition cap (AC 14).

### T02.3 — The diff engine
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ T02.1, T02.2, PRD 00 T00.3

Diff the observed set against stored membership **keyed on PostHog `person_id`** (AC 11),
never on resolved contacts — a resolver outage must not be able to subtract a member
(DECISIONS §2.6). Persist the source `person_id` on the membership at join.

Identity resolution touches only the **join** leg:

- Call PRD 00's **find-only `lookupPostHogPerson`** for the diff. It creates nothing —
  that is precisely why PRD 00 splits the two functions.
- Create a contact via `resolvePostHogPerson` **only for members carrying an email**
  (DECISIONS §2.3). Anonymous-only members are recorded unresolved and imported for size
  fidelity; existing preference and channel gates already no-op them. Contacts created per
  tick are bounded and reported (AC 16).
- A resolver **throw** makes the observation incomplete and aborts the whole diff (AC 3a).
  A resolver **miss** is counted, never a leave (AC 7).

Produce a transition list. Pure and unit-testable in isolation from IO. Satisfies AC 1, 2,
4, 7, 8, 11, 16.

**Write the AC 3/3a test first.**

### T02.4 — The sync workflow
_Boundary:_ `packages/engine/src/workflows/` · _Depends:_ T02.0, T02.3, **PRD 01 T01.3**

A new Hatchet task on its own cron, self-bootstrapping `db`/`logger` from `process.env`
like `bucketReconcileTask` does. Single-flight concurrency per cohort.

**Applies the transition list exclusively through PRD 01 T01.3's `addBucketMember` /
`removeBucketMember`, consuming their `{ emitted, epoch, verdict }` return. It calls
`emitBucketTransition` zero times** (AC 2a, DECISIONS §2.7). Those functions own the
`bucket_memberships` write, the epoch, `maxDwellAt`, the `entryLimit` gate, `minDwell`
deferral, and the emit — which is how this PRD gets all five for free. The hard dependency
on T01.3 is therefore structural, not incidental: without it there is no writer, nothing to
diff against, no epoch, and the poller re-emits joins forever.

Each tick: cheap LIST check (cohort still present + `last_calculation` advanced + PRD 03's
definition re-walk) → pull → diff → cap check → apply. Persists cursor, degraded flag, and
consecutive-failure count in `import_jobs` (T02.0's column).

### T02.5 — Cohort listing for discovery
_Boundary:_ `packages/engine/src/routes/admin/` · _Depends:_ T02.1

A read-only admin endpoint listing available PostHog cohorts, so an operator can see what
is bindable. Follows the `provision-loop` credential pattern
(`routes/admin/analytics.ts:232-357`): route-local token manager, `409
no_posthog_credential`, typed error → 502.

### T02.6 — Seed on first observation
_Boundary:_ `packages/engine/src/workflows/` + `packages/engine/src/lib/` ·
_Depends:_ T02.4, PRD 01 T01.3 (bulk/seed path)

The first observation of a binding materializes membership rows through PRD 01's
**non-emitting** bulk/seed path with a seed source, and emits nothing (AC 12). Only
subsequent diffs emit. This mirrors `bucket-backfill.ts:56-66` — the Customer.io rule —
which the engine already applies to every newly registered dynamic bucket.

Also here:

- `emitOnSeed: true` on the binding opts into enrolling the existing population (AC 13).
- The per-tick transition cap: above N computed transitions, abort the tick, emit nothing,
  alert (AC 14). A sanctioned `maxCohortSize` of 100k makes the blast radius large enough
  that a partial burst is not an acceptable degradation.
- A binding **preview** reporting "would emit N joins" before the first real tick (AC 15).

Mutation-test the suppression: a seed test that still passes when the non-emitting path is
swapped for the emitting one certifies rather than fails.

## Seams

A real PostHog project with a populated cohort is required for genuine end-to-end
verification. Build and demo against a deterministic Fake cohort client covering: happy
path, mid-pull page failure, genuinely-empty cohort, oversized cohort, unresolvable
member, **a 404/403/410 on a bound cohort, a throwing identity resolver, a first-observation
seed, and a tick that exceeds the transition cap**. Enumerate the real-project run as a
human verification step.

## Done when

All ACs pass, gates green, and against the Fake:

- a cohort membership change drives a journey enrollment end-to-end;
- an injected mid-pull page failure produces zero transitions rather than a mass leave;
- an injected resolver throw produces zero transitions rather than a mass leave;
- a 404 on a bound cohort produces zero transitions and a degraded binding;
- binding a Fake cohort with 500 existing members produces 500 membership rows and **zero**
  emissions, and the second tick — with one member added — emits exactly one join;
- `bucket_memberships` rows written by the sync carry a real epoch, verified by asserting
  the row, not by asserting the emission count.

## Implementation Notes
