# PRD 19 — two of the four quality gates cannot fail, and one cannot run

## Goal
Make `DECISIONS.md` §4's gate commands actually execute and actually mean something. Right now a
delivery agent can run all four, see nothing red, and have proven strictly less than it believes. A
gate that cannot fail is worse than no gate, because it is reported as evidence.

## The diagnosis (settled — do not re-derive)

### Defect 1 — the cross-workspace test gate DIES before running anything, when invoked with `-C`

`DECISIONS.md` §4 names `pnpm turbo run test --filter='!@hogsend/api'`. Agents are told to prefix
every command with `pnpm -C <worktree>` (correctly — a bare `cd` in a compound shell command silently
resets to the MAIN checkout, which is its own recorded trap). The combination does not work:

```
$ pnpm -C <worktree> turbo run test --filter='!@hogsend/api'
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with EACCES: … turbo run test '--filter=!@hogsend/api'
spawn <worktree> EACCES
```

Root cause: the root `package.json` has NO `turbo` script (it has `"test": "turbo run test"`), so
pnpm falls through to executing `turbo` as a binary and mis-spawns the directory. Confirmed:
`pnpm -C <worktree> turbo --version` fails identically, while `pnpm -C <worktree> exec turbo --version`
prints `2.9.14`.

**Why this matters more than a typo.** The failure text says `Command failed` and exits non-zero —
it looks exactly like a failing test suite. An agent that reports "gate FAILED, investigating" wastes
a cycle; an agent that reports "gate ran" has reported a lie. And this is the ONE gate that catches
the recorded `@hogsend/testing` defect, where adding an export to `engine/testing.ts` drags
import-time `env.ts` validation into a package with no env — a failure that shipped RED once while
lint, engine `tsc`, the whole `apps/api` suite and `build` were ALL green.

Correct forms: `pnpm -C <dir> exec turbo run test --filter='!@hogsend/api'`, or `pnpm -C <dir> test`.

### Defect 2 — the `apps/api` gate cannot be green, so nobody can honour it

`cd apps/api && pnpm test` appears in every PRD's Done-when. It has a reproducible red on a clean
`main` (PRD 17) plus a concurrency flake (PRD 18). A gate that is known-red is a gate everybody
learns to wave through, which is how a REAL regression gets waved through with it.

### Defect 3 — `pnpm check-types` is vacuous, and is still cited

§4 already documents this — turbo hashes git-tracked files only, so uncommitted NEW files never move
the cache key and the root task returns `FULL TURBO` on work it never looked at. But PRD 08's own
Done-when still lists `pnpm check-types`, and it is not the only one. The correction exists in prose
and is contradicted by the checklists agents actually copy.

## Locked decisions specific to this PRD
- Gate commands in `DECISIONS.md` are stated in a form that RUNS as written, including the `-C`
  prefix agents are required to use. A command that only works when you happen to be in the right
  directory is not a gate.
- Every gate must be demonstrated to FAIL on a deliberate break before it is trusted. That
  demonstration is recorded in the PRD's Implementation Notes.
- `pnpm check-types` is removed from Done-when lists in favour of per-package `tsc --noEmit`. The
  prose correction stays, but no checklist may contradict it.
- PRD 19 does NOT fix the tests themselves — 17 and 18 own those. 19 owns the COMMANDS and the
  checklists.

## Acceptance criteria (EARS)

- WHEN a delivery agent copies a gate command verbatim from `DECISIONS.md` §4 and prefixes it with
  `pnpm -C <worktree>`, the command SHALL execute the intended task.
- WHEN the cross-workspace test gate is run, a deliberately broken package SHALL make it exit
  non-zero, and the output SHALL name the failing package.
- WHEN a gate cannot currently be green for reasons outside a task's boundary, `DECISIONS.md` SHALL
  say so explicitly and name the owning PRD, so a red gate is never silently normalised.
- WHEN a Done-when list names a typecheck gate, it SHALL name the per-package `tsc --noEmit` form and
  SHALL NOT name `pnpm check-types`.

## Tasks

### T1 — Fix the gate command strings in DECISIONS §4
_Boundary:_ plan docs (orchestrator only)
_Depends:_ —

Rewrite §4's block so every line runs as written under the `-C` convention. Add a one-line note on
the `turbo` form explaining WHY `exec` is needed (no root `turbo` script; pnpm otherwise mis-spawns
the directory and the EACCES reads like a test failure). Keep the existing rationale paragraphs on
`check-types` vacuity and on why `apps/api` alone is not the test gate — both are correct and
hard-won.

### T2 — Prove each gate can fail
_Boundary:_ repo-wide, temporary edits only
_Depends:_ T1

For each of the four gates, introduce a deliberate break, run the gate, confirm it exits non-zero and
names the right thing, then REVERT:
- lint → a formatting violation
- per-package `tsc --noEmit` → a type error in that package
- `apps/api` test → a broken assertion
- cross-workspace turbo test → a broken test in a NON-api package (this is the one that has never
  been demonstrated; the `@hogsend/testing` incident is the case it must catch)

Record all four outputs in Implementation Notes. Revert everything; confirm `git status` is clean.

### T3 — Purge `pnpm check-types` from Done-when lists
_Boundary:_ plan docs (orchestrator only)
_Depends:_ T1

Sweep `.claude/plans/account-links/prds/*.md` for `check-types` in Done-when lists and replace with
the per-package form. Do not touch prose that explains the vacuity — that is the reason, and it stays.

### T4 — Record the known-red gates and their owners
_Boundary:_ plan docs (orchestrator only)
_Depends:_ —

Add a short block to §4 naming the currently-red gates, their owning PRD (17, 18), and the rule that a
red gate outside your boundary is REPORTED, never normalised and never worked around by weakening a
test. Remove the block as 17 and 18 land.

## Seams
None.

## Done when
- [ ] Every §4 gate command runs as written with the `-C` prefix.
- [ ] All four gates were demonstrated to fail on a deliberate break, outputs recorded.
- [ ] The cross-workspace gate was proven to catch a broken NON-api package specifically.
- [ ] No Done-when list names `pnpm check-types`.
- [ ] §4 names the currently-red gates and their owning PRDs.
- [ ] `git status` clean after T2's reverts.

## Implementation Notes

**T1, T3, T4 shipped `bfd06587`. T2 (the proofs) run 2026-08-14, tree reverted clean.**

T3 was WORSE than this PRD described. The Done-when checklists did not merely cite the vacuous
`check-types` — **sixteen of them omitted the cross-workspace gate entirely**, listing only
`pnpm lint / pnpm check-types / cd apps/api && pnpm test`. So every PRD in this stack was gated by a
typecheck that skips uncommitted files plus no coverage at all of the one gate below. All sixteen
fixed; the prose explaining the vacuity stays.

**T2 — all four gates were watched failing, and gate 4's justification is now PROVEN rather than
recounted.** The first attempt at the literal historical repro (`export { env }` from
`engine/testing.ts`) did NOT reproduce — and that is itself a finding: the incident was remediated in
`packages/testing/vitest.config.ts`, which now injects the vars under a comment naming this exact
failure. That config block is load-bearing and the env-drag edge is live TODAY via the account-link
store.

So the CLASS was reproduced with a fresh edge that block does not cover — an env module requiring
`ADMIN_API_KEY` (present in `apps/api`'s test env, absent from `packages/testing`'s), exported from
`engine/testing.ts`. Against that one state:

| Gate | Result |
| --- | --- |
| lint | **GREEN** |
| `packages/engine` `tsc --noEmit` | **GREEN** |
| `apps/api` test | **GREEN** — 2591 passed |
| cross-workspace turbo test | **RED** — `@hogsend/testing` 6 suites failed, `Tests no tests` |

**Three of four gates certified a change that took a package from 74 passing tests to zero.** That is
the entire argument for the gate, and it is now evidence rather than a story.

**A second vacuity was found and is now recorded in §4:** `turbo run test` is cache-vacuous for
untracked new files exactly as `check-types` is — a re-green run reported `FULL TURBO` in 199ms having
executed nothing. The gate-4b proof was only picked up because the same change also edited a TRACKED
file. Use `--force` when your change is new files.

**One correction to this PRD's Defect 2:** `apps/api` ran fully green three times on this branch, so
it is no longer a known-red gate. §4's table records it as green as of `4c3f8b70` rather than red — a
stale known-red entry is itself a licence to wave a gate through.
