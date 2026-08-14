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
| `apps/api/.../contact-id-backfill.test.ts` — `the sweep vs the contact-scoped uniqueness indexes (PRD 05 T3)` | Fails only under full-suite concurrency; PASSES alone (verified this run: 22/23 alone, then failing in the 247-file run). |
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

## Implementation Notes
