# PRD 18 — global-count assertions fail at random under a shared Postgres

## Goal
Kill a whole CLASS of flake: tests that assert on GLOBAL row counts (or on "the table is empty")
while every other file in the suite seeds rows into the same Postgres concurrently. Scope each
assertion to rows the test OWNS. The point is not to make the current offenders green — it is that
this failure mode gets misattributed to whatever change happens to be in flight when it next fires.

## The diagnosis (settled — do not re-derive)

`apps/api` runs test files in parallel against ONE docker Postgres (`localhost:5434`). A test that
counts rows matching a broad predicate therefore sees rows produced by files it knows nothing about.
The symptom is a failure set that DRIFTS between runs on an unchanged tree, which reads exactly like
a regression in the current diff and is not one.

Confirmed instances:

| Test | Mechanism |
| --- | --- |
| ~~`apps/api/.../contact-id-backfill.test.ts`~~ | **RETRACTED — this row was WRONG. It is not this class at all.** See "The T1 correction" below. |
| `apps/cloud/.../ops-stats.test.ts` — `readOpsStats` | **Mechanism already diagnosed and recorded**: `readOpsStats` reads GLOBAL fleet counts while the rest of the suite seeds the same database, so `zero-fills every enum key on an empty fleet` is only ever true when nothing else is running. Any new seed makes it likelier. |
| `apps/cloud/.../publish-cli-auth.test.ts` — `refuses a REVOKED session, storing nothing` | Failed twice in five full-suite runs. **The security reading is RULED OUT** — `CliSessionService` refuses on `if (row.revokedAt)`, a null check, so there is no window where a revoked session is accepted. What remains fits contention: the test asserts `buildRows(envA)` is EMPTY while sharing one Postgres. |

The same file already documents the correct instinct in its own comment at
`contact-id-backfill.test.ts:640-647`: it deliberately asserts
`result.statements > result.updated` because *"that inequality is concurrency-proof"*, and pins the
exact claim on its own fixture rather than the global counter. That is the pattern to generalise.

**The fix is to scope the assertion, NOT to retry it.** A retry makes a real regression take longer
to surface and turns a deterministic failure into a slow one. Serialising the whole suite is also
rejected — the suite is already 180s and `WEBHOOK_FANOUT` exists precisely so only the files that
genuinely need serialisation pay for it.

## Locked decisions specific to this PRD
- Every assertion is scoped to rows the test owns, via its existing run-scoped id prefix (`uid(...)`,
  `RUN`-prefixed keys) or an explicit `WHERE` on its own fixture.
- No retries, no `waitFor` loops around a count, no `toBeGreaterThan(0)` softening. An exact claim
  about owned rows stays exact.
- Serialisation via the `WEBHOOK_FANOUT` barrier is a LAST resort, legitimate only where the
  production code genuinely reads global state (`emitOutbound` selecting endpoints globally is the
  existing, correct example). It is not a substitute for scoping.
- `apps/cloud` offenders are in scope. The cloud suite has its own recorded hazard — a drifting
  failure set there is 5434 contention, not a regression — so a fix there pays twice.

## Acceptance criteria (EARS)

- WHEN a test asserts a row count, the predicate SHALL restrict to rows that test created.
- WHEN the full suite runs concurrently, the three named tests SHALL pass.
- WHEN the three named tests run in isolation, they SHALL still pass (scoping must not depend on
  contention existing).
- WHEN the production behaviour a scoped test covers regresses, that test SHALL still fail — scoping
  narrows WHICH rows are counted, never WHETHER the claim is checked.
- WHEN a test genuinely must read global state, it SHALL be registered in the serial barrier with a
  comment naming why, rather than silently scoped into vacuity.

## Tasks

### T1 — `contact-id-backfill.test.ts`: scope the PRD 05 T3 case
_Boundary:_ `apps/api`
_Depends:_ —

Reproduce first: run the file alone (expect green), then under `pnpm -C apps/api test` (expect the
failure). Capture the ACTUAL assertion diff — which assertion, expected vs received — rather than
assuming it is the same shape as the others. Then scope that assertion to the fixture's own
`uid("t3-…")` keys.

Do NOT touch the already-concurrency-proof assertions at `:645-646`; they are the model, not the
problem.

PROVE the scoped assertion still bites: break the sweep's collision-skip behaviour, watch the case
FAIL, restore.

### T2 — `ops-stats.test.ts`: scope the fleet counts
_Boundary:_ `apps/cloud`
_Depends:_ —

`readOpsStats` returns GLOBAL counts, so `zero-fills every enum key on an empty fleet` cannot be made
true by scoping the assertion alone — the FUNCTION is global. Choose deliberately and record which:
either seed a known baseline and assert the DELTA the test's own rows produce, or assert the shape
(every enum key present, every value a non-negative integer) and move the exact-count claim onto a
scoped query. State the reasoning in a comment.

Run the cloud suite on a THROWAWAY container rather than the shared 5434, per the recorded hazard, so
the result is not itself contaminated.

### T3 — `publish-cli-auth.test.ts`: capture the real diff, then scope
_Boundary:_ `apps/cloud`
_Depends:_ —

The security hypothesis is already ruled out; do not re-litigate it. Capture the actual assertion
diff when it fires (the recorded ask), then scope `buildRows(envA)` to the test's own environment.
Note the alternative that also fits the evidence — a burst-limit 429 arriving where a 401 was
expected — and if the captured diff shows that instead, say so plainly and fix THAT rather than
forcing the contention story.

### T4 — A note in DECISIONS so the class stops recurring
_Boundary:_ plan docs (orchestrator only)
_Depends:_ T1, T2, T3

Add a short standing rule to `DECISIONS.md` §4: assertions on row counts are scoped to owned rows;
a drifting failure set across runs on an unchanged tree is contention, not a regression; diagnose
before blaming the diff in flight.

## Seams
None.

## Done when
- [ ] The three named tests pass BOTH in isolation and under their full suites.
- [ ] Each fixed assertion was proven to still fail on a real regression.
- [ ] No retry loop, no `toBeGreaterThan(0)` softening, no whole-suite serialisation was introduced.
- [ ] `DECISIONS.md` carries the standing rule.
- [ ] `pnpm lint`
- [ ] `pnpm -C apps/api test`
- [ ] the `apps/cloud` suite, on a throwaway container.

## The T1 correction (2026-08-14) — global COST, not global COUNT

**T1 SHIPPED as `4c3f8b70`, but not as this PRD specified it, because the premise was wrong.** BUILD
was told to capture the actual assertion diff before assuming the shape, and doing so refuted the row.

There is no assertion diff. **The failure is a 30s TIMEOUT**, and the four assertion failures
underneath it were one cascade from it:

```
× skips colliding stamps, folds the preference opt-out, and never aborts   30001ms
  Error: Test timed out in 30000ms.
```

Two facts rule this class out for this file, and I should have checked both before writing the row:

1. **`contact-id-backfill.test.ts` is already in the serial `webhook-fanout` project** (`maxWorkers: 1`).
   Nothing else runs while it runs, so cross-file contention cannot be the mechanism.
2. **Its counting assertions are already scoped**, and the file documents that at `:592-600` and
   `:639-644`.

The real mechanism is **cost, not contention**. `runContactIdBackfill` walks every live contact and
issues one bounded `UPDATE` per (contact, table) even when it writes nothing: measured against the
shared dev database, 17,469 live contacts + 530 stale alias keys ⇒ ~108,000 statements ⇒ **~20s per
sweep**. The T3 case drove TWO sweeps inside a 30s default. No amount of `WHERE`-scoping helps, because
the rows the sweep pays for belong to other files.

The blast radius explains the cascade, and is the transferable lesson: **vitest fails a timed-out test
but does not stop the async work it started.** The abandoned sweep kept stamping while the file moved
on, which is why one timeout produced five failures — including one on the very assertion this PRD
told BUILD not to touch, which had not failed on its own merit.

Fix shipped: a `SWEEP_BUDGET_MS = 90_000` budget on the three sweep-driving describes (sized to a
whole-database job, ~4.5x the measured sweep), and the two-sweep case split so each test reports one
verdict for one sweep. Every assertion byte-identical; 100 `expect(` calls before and after.

**Amend the T4 standing rule accordingly.** The count-scoping rule still stands for T2/T3, but it is
not the whole class. Add:
- A test that drives a whole-database production job needs a timeout budget sized to THAT JOB, not the
  suite default — and the budget should carry the measurement that justifies it.
- A timed-out async test does not stop the work it started; the rest of the file inherits it. When one
  timeout is followed by a cluster of assertion failures in the same file, suspect the cascade before
  diagnosing each failure separately.

**Two hazards recorded for whoever runs this suite:**
- **Two concurrent PROCESSES running this file both run the global sweep and steal each other's
  stamps.** An interim run failed with `expected 0 to be greater than or equal to 6` and passed two
  minutes later on identical code. If another agent runs `apps/api test` at the same time, this file's
  result is meaningless.
- **The growth is unfixed.** The suite seeds contacts it never deletes (19,376 rows), so every sweep
  gets slower forever. The budget buys ~4x. Durable fixes — a scope argument on
  `runContactIdBackfill`, or periodically truncating the dev database — are outside T1.

## Implementation Notes

T1 shipped (`4c3f8b70`) per the correction above. Full `apps/api` suite: **0 failures**, 2591 passed.
The scoped case was mutation-proved — replacing the collision-skip guard with `sql.empty()` makes it
fail with a 23505 on its OWN fixture key, then reverted clean.

**T2 and T3 (`apps/cloud`: `ops-stats`, `publish-cli-auth`) are NOT started.** Their rows in the
Confirmed-instances table stand — both have recorded global-count mechanisms and neither was touched
here. Note that T1's retraction is a warning for them too: capture the ACTUAL failure before assuming
it is this class.
