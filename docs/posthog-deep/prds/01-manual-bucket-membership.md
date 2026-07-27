# PRD 01 — `manual-bucket-membership`

**Depends on:** nothing. **Status:** `[ ]`

## Goal

Unlock `BucketMeta.kind: "manual"` end-to-end: the schema accepts it, membership-age
passes run for it, and a guarded write path mutates membership — one seam that owns the
`bucket_memberships` write and *then* calls `emitBucketTransition`.

## Why this ships before any PostHog code

This is a standalone engine capability with independent value: CSV audience import, admin
tagging, SDK-driven audiences. Shipping it first makes the cohort sync a *thin plugin on
top of a proven engine primitive*, which is exactly the posture that keeps PostHog
non-load-bearing. It can ship as its own release even if the PostHog work slips.

## Locked decisions

- The membership-write route mirrors the `/v1/groups` security boundary: **secret-key
  only**, `requireApiKey` + `requireScope("ingest")`. Publishable/browser keys may never
  mutate membership.
- **`addBucketMember`/`removeBucketMember` own the membership write AND the emit.**
  `emitBucketTransition` (`packages/engine/src/lib/bucket-emit.ts:33`) **only emits** — it
  takes `epoch` as an *input*, it does not derive it and it does not touch
  `bucket_memberships`. Every existing producer writes the row itself and *then* calls it.
  So these two functions are the single membership-mutation seam: they own the
  `bucket_memberships` write, the epoch via `countPriorMemberships()`, `maxDwellAt` via
  `computeMaxDwellAt()`, the `entryLimit` gate via `shouldEmitJoin()`, `minDwell`
  deferral, and then the `emitBucketTransition` call. Callers (the route here, PRD 02's
  poller) call `emitBucketTransition` **never**. This preserves epoch idempotency,
  `entryLimit` gating, the `contactId` provenance pin, and outbound catalog emission.
- **They return a real contract, not `void`.** PRD 02's diff engine consumes it, so it is
  part of this PRD's committed surface: at minimum `{ emitted: boolean; epoch: number;
  verdict: <applied | already-active | already-left | deferred | suppressed-by-entry-limit
  | seeded> }`. A caller must be able to tell "I wrote a row and emitted" from "I wrote a
  row and deliberately did not emit" without re-querying.
- **They are callable from a workflow task with no request container.** PRD 02's poller is
  a Hatchet task that self-bootstraps `db`/`logger` from `process.env` like
  `bucketReconcileTask` does. The signature therefore takes explicit
  `{ db, registry, hatchet, logger, ... }` dependencies — never `c.get("container")`, never
  a module-level singleton resolved from a request.
- **A bulk/seed path writes without emitting.** `seedBucketMembers` (or an
  `emit: false`/`source: "seed"` mode on the same function) materializes rows with epoch
  and `maxDwellAt` computed correctly but emits nothing, mirroring
  `bucket-backfill.ts:56-66` ("the Customer.io rule"). PRD 02 §seeding depends on this;
  CSV audience import wants it independently.
- Manual buckets remain excluded from criteria recompute. They gain only the
  membership-age passes that are criteria-independent.

## The subtle part

Four independent `kind === "manual"` skip sites currently encode **different intents that
happen to coincide**:

- `packages/core/src/registry/bucket.ts:65-68` — skip the event/property inverted indexes.
  Correct permanently; manual buckets have no criteria to index.
- `packages/engine/src/buckets/check-membership.ts:144-151` — skip real-time criteria
  evaluation. Correct permanently.
- `packages/engine/src/workflows/bucket-reconcile.ts:102` — skip the *entire* per-bucket
  loop body. **This one is wrong once manual buckets exist**: it also skips `maxDwell` TTL
  leaves, `minDwell`-deferred leave resolution, and dwell reactions, all of which are
  criteria-independent and should run.
- `packages/engine/src/workflows/bucket-backfill.ts:90,647` — hard-reject/never-enqueue.
  Correct permanently; backfill is criteria-driven by definition.

Splitting the reconcile skip into criteria-only, without accidentally re-enabling criteria
recompute for manual buckets, is where a subtle bug lands. **Mutation-test this** — a wrong
test here certifies rather than fails.

## Acceptance criteria (EARS)

1. WHEN a bucket is registered with `kind: "manual"` and no `criteria`, the system SHALL
   accept it.
2. WHEN a bucket is registered with `kind: "manual"` AND `criteria`, the system SHALL
   reject it loudly at registration.
3. WHEN a member is added to a manual bucket via the write path, the system SHALL create
   an active membership row and SHALL emit `bucket:entered:<id>` subject to the bucket's
   `entryLimit`.
4. WHEN a member is removed, the system SHALL transition the row to `left` and SHALL emit
   `bucket:left:<id>`, subject to `minDwell` deferral.
5. WHEN an already-active member is added again, the system SHALL be idempotent: no
   duplicate row, no second emission.
6. WHEN a manual bucket has `maxDwell` and a member exceeds it, the reconcile cron SHALL
   force-leave that member.
7. WHEN a manual bucket has `minDwell` and a leave arrives inside the window, the system
   SHALL defer the leave, never drop it.
8. WHEN the reconcile cron processes a manual bucket, it SHALL NOT evaluate criteria and
   SHALL NOT attempt criteria-driven joins or leaves.
9. WHEN a membership mutation is attempted with a publishable key, the system SHALL refuse.
10. WHEN `addBucketMember` or `removeBucketMember` returns, it SHALL report whether a
    transition was emitted, the epoch it used, and a verdict distinguishing applied /
    already-active / already-left / deferred / suppressed-by-entry-limit / seeded — so a
    caller can act on the outcome without re-querying `bucket_memberships`.
11. WHEN `addBucketMember`/`removeBucketMember` are invoked from a Hatchet workflow task
    with no request container — dependencies passed explicitly — they SHALL behave
    identically to a route-originated call.
12. WHEN the bulk/seed path is used, the system SHALL write membership rows with correct
    epoch and `maxDwellAt` and SHALL emit **no** transitions, mirroring
    `bucket-backfill.ts:56-66`.

## Tasks

### T01.1 — Accept `kind: "manual"` at registration
_Boundary:_ `packages/core` · _Depends:_ —

Replace the reject at `packages/core/src/schemas/bucket.schema.ts:114-123`. Manual buckets
skip the dynamic-only rules (at-least-one-positive, reserved `bucket:*` in criteria,
no-email_engagement) naturally by having no criteria, but must still be subject to the
`minDwell <= maxDwell` coherence check at `:95-105`, which applies regardless of kind.
Add the inverse rule: manual + criteria is rejected (AC 2).

### T01.2 — Split the reconcile skip
_Boundary:_ `packages/engine/src/workflows/bucket-reconcile.ts` · _Depends:_ T01.1

Replace the blanket early-continue at `:102` with criteria-scoped guards, so
`reconcileBucketTtlLeaves` (`:503-540`), `minDwell`-deferred leave resolution, and
`reconcileBucketDwell` (`:649-782`) run for manual buckets while `reconcileBucketLeaves`,
`reconcileCompositeLeaves`, and `reconcileBucketJoins` do not. Mutation-test each of the
six paths independently.

### T01.3 — Membership mutation service
_Boundary:_ `packages/engine/src/buckets/` · _Depends:_ T01.1

`addBucketMember` / `removeBucketMember`. Each **writes the `bucket_memberships` row
itself and then calls `emitBucketTransition`** — the order the three existing producers
already use, because `emitBucketTransition` only emits and takes `epoch` as an input
(`bucket-emit.ts:33-55`). Use `countPriorMemberships()` (`membership-epoch.ts:26-40`) for
`entryCount`/epoch and `computeMaxDwellAt()` (`:91-95`) on join. Apply `shouldEmitJoin()`
for the `entryLimit` gate and `minDwell` deferral on leave. Set `source` appropriately.
Idempotent per AC 5 via the partial-unique active index (`uq_user_bucket_active`).

Return the `{ emitted, epoch, verdict }` contract (AC 10) — PRD 02's poller consumes it
directly, so treat it as a committed surface rather than an implementation detail.
Dependencies are passed explicitly (`{ db, registry, hatchet, logger }`) so a Hatchet task
can call it with no request container (AC 11).

Also ship the non-emitting bulk/seed path (AC 12) — `seedBucketMembers`, or an
`emit: false` mode on the same function — writing rows with correct epoch and `maxDwellAt`
while emitting nothing, mirroring `bucket-backfill.ts:56-66`. PRD 02's first-observation
seed and CSV audience import both consume it. Mutation-test it: a seed test that still
passes when the emit suppression is removed is vacuous.

### T01.4 — Secret-key membership route
_Boundary:_ `packages/engine/src/routes/` · _Depends:_ T01.3

`/v1/buckets/:id/members` add/remove/list, mirroring the `/v1/groups` router's guard
composition. Reject mutation on a non-manual bucket — criteria own that membership.

### T01.5 — Admin read surface
_Boundary:_ `packages/engine/src/routes/admin/buckets.ts` · _Depends:_ T01.3

Surface `kind` on the existing detail endpoint so Studio can distinguish manual from
dynamic. Observe-only; no authoring UI (engine-over-Studio law).

## Seams

None. This PRD is fully self-contained in-repo.

## Done when

All ACs pass, gates green, and a manual bucket demonstrably drives a journey end-to-end:
register manual bucket → add member via the route → journey triggered by
`bucket:entered:<id>` enrolls → remove member → `bucket:left:<id>` emitted.

## Implementation Notes
