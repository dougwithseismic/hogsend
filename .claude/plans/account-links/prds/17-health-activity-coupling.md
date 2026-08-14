# PRD 17 — `health-activity` asserts a coupling the route deliberately refuses

## Goal
Make `apps/api/src/__tests__/health-activity.test.ts` green by fixing the TEST, which asserts an
invariant `routes/health.ts` is deliberately designed not to provide. Today this file is a
reproducible red on a clean `main`, which means the gate every PRD's Done-when names —
`cd apps/api && pnpm test` — cannot pass for anybody, on any branch.

## The diagnosis (settled — do not re-derive)

The failing case is `reports counts when the DB is up, degrades to nulls when it is not`
(`health-activity.test.ts:19-40`). It reads `body.components.database.status`, and if that is `"up"`
it requires all four activity counts to be numbers:

```ts
const dbUp = body.components.database.status === "up";
if (dbUp) { expect(value).toBeTypeOf("number"); } else { expect(value).toBeNull(); }
```

Observed failure: `AssertionError: expected null to be type of 'number'` — i.e. `dbUp === true` while
a count was `null`.

**That state is legal and intended.** `routes/health.ts` degrades the counts to `NULL_ACTIVITY`
independently of the component check, by TWO separate paths:

1. **A deadline.** `getRecentActivity` (`health.ts:106-115`) races `queryRecentActivity` against
   `ACTIVITY_TIMEOUT_MS = 1500` and resolves `NULL_ACTIVITY` if the query loses. The comment above it
   (`health.ts:95-99`) states the intent outright: *"Reporting must never slow the healthcheck down …
   the whole thing is raced against a short deadline and degrades to nulls."*
2. **A bare catch.** `queryRecentActivity` (`health.ts:147-149`) returns `NULL_ACTIVITY` on ANY throw,
   *"so a reporting hiccup can't take the healthcheck down"*.

Neither path consults, or is consulted by, the database component check. The component check is a
fast liveness ping; the counts are two windowed `COUNT(*) FILTER` queries over `journey_states` and
`email_sends`. A reachable database that answers a ping in 5ms can easily take more than 1500ms to
return those counts under a loaded 247-file suite run — and it does.

So `database.status === "up"` AND `counts === null` is exactly the degradation the route was built
for. The test forbids the feature.

**The product code is correct. Do not "fix" the route.** Raising or removing `ACTIVITY_TIMEOUT_MS`,
or coupling the counts to the component status, would trade a healthcheck that always answers fast
for one that can hang behind a slow pool — which is the precise failure the deadline was added to
prevent, and a healthcheck that hangs takes a Railway deploy down.

## Locked decisions specific to this PRD
- The route's three-way outcome is the contract: counts are `number` on a timely successful query,
  and `null` on EITHER a timeout OR a query error, regardless of component status.
- The test must assert the SHAPE contract (`number | null`, and `>= 0` when a number), not a
  cross-field coupling that does not exist.
- A weaker assertion is only acceptable if it still fails on a real regression. Deleting the case, or
  relaxing it to `expect(value).toBeDefined()`, is NOT acceptable — see T2.

## Acceptance criteria (EARS)

- WHEN the activity query returns within the deadline, the system SHALL report each of
  `journeys.failed`, `journeys.completed`, `emails.failed`, `emails.sent` as a number `>= 0`.
- WHEN the activity query exceeds `ACTIVITY_TIMEOUT_MS` or throws, the system SHALL report all four
  counts as `null` AND SHALL still return HTTP 200 with a valid `status`.
- WHEN the database component is `"up"` but the activity query degraded, the system SHALL NOT be
  treated as a failure by any test — the two are independent by design.
- WHEN a future change makes a count report a non-numeric, non-null value (a string, `undefined`, a
  negative number), the suite SHALL fail.
- WHEN a future change removes the degradation path entirely (so a slow query throws out of the
  handler instead of returning nulls), the suite SHALL fail.

## Tasks

### T1 — Replace the coupling assertion with the real shape contract
_Boundary:_ `apps/api`
_Depends:_ —

Rewrite the failing case in `apps/api/src/__tests__/health-activity.test.ts` to assert what the route
actually guarantees: each count is `number | null`; when it is a number it is `>= 0` and an integer.
Drop the `dbUp` branch — it encodes a coupling that does not exist. Replace the test name with one
that describes the real contract (e.g. `reports each activity count as a non-negative number or null`).

Leave a comment naming WHY the coupling was wrong, pointing at `health.ts:95-99` and the two
degradation paths, so the next person does not re-introduce it thinking they are tightening the test.

### T2 — Pin the degradation itself, so the relaxed assertion still bites
_Boundary:_ `apps/api`
_Depends:_ T1

T1 alone makes the file green by asserting LESS, which is exactly the move this repo's standing law
warns about — a wrong test certifies rather than fails. Add a case that exercises the degradation
path directly rather than hoping to observe it: drive `getRecentActivity`'s failure branch (inject a
`db` whose `select` rejects, or otherwise force `queryRecentActivity` to throw) and assert all four
counts come back `null` with HTTP 200 and a valid `status`.

PROVE it non-vacuous: remove the `catch` at `health.ts:147-149` so the throw escapes, watch the new
case FAIL, then restore. Report both outputs. A degradation test that never enters the degradation
path is worth nothing.

### T3 — Confirm the file is green in isolation AND under the full suite
_Boundary:_ `apps/api`
_Depends:_ T1, T2

Run `pnpm -C apps/api exec vitest run src/__tests__/health-activity.test.ts` (fast, low contention)
and then the full `pnpm -C apps/api test` (slow, high contention). The original defect only reliably
showed under load, so a green single-file run is not evidence. Report both.

## Seams
None. No credential, no external service, no human decision.

## Done when
- [ ] `health-activity.test.ts` passes in isolation and under the full `apps/api` suite.
- [ ] The `dbUp` coupling is gone and a comment records why it was wrong.
- [ ] A test exercises the null-degradation path directly and was PROVEN to fail without the catch.
- [ ] `routes/health.ts` is UNCHANGED — no timeout raised, no coupling added.
- [ ] `pnpm lint`
- [ ] `pnpm -C packages/engine exec tsc --noEmit`
- [ ] `pnpm -C apps/api test` shows this file green.

## Implementation Notes
