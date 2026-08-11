# PRD 12 — Scaffold verify covers `plugin-hogsend`

**Status:** `[ ]` · **Depends:** 10 · **Boundary:** `packages/create-hogsend`

## Goal

Close a narrow, real gap in the packaging smoke. `scripts/verify-scaffold.sh` already packs
`plugin-hogsend`, asserts `--with hogsend` adds it as a direct dependency, and asserts
`.env.example` surfaces `HOGSEND_EMAIL_TOKEN`. What it does NOT do is import it.

Step 7b proves the engine's runtime-assembled dynamic-import idiom resolves under plain `node` from
a scaffolded app, and it proves it for `plugin-apollo` only. `plugin-hogsend` uses the identical
idiom and is never actually loaded anywhere in the harness. That idiom has broken before (#611, a
raw-`.ts` runtime entry that `tsx` masked), and it breaks per-package, not globally.

## Locked decisions

- **Extend step 7b, do not add a parallel step.** The assertion already exists in the right shape
  with the right comment explaining why it must be plain `node` and not `tsx`. A second copy would
  drift from the first.
- **The import must run from an app that actually has the package installed.** The existing
  `--with hogsend` scaffold at `$WITH_DIR` uses `--no-install`, so it has no `node_modules` and
  cannot satisfy this. Resolve that explicitly rather than asserting against an empty tree; a test
  that passes because the loop body never ran is the vacuous-green failure this repo has recorded
  before.
- **Assert the factory export by name.** Resolving the module is not enough: `createHogsendEmailProvider`
  is the exact named export `emailProvidersFromEnv` reaches for, and a rename would leave the import
  working and the preset silently dead.
- **No new CI job and no added wall-clock beyond the install.** This runs inside the existing
  scaffold smoke, which is already scoped to packaging-path changes.

## Acceptance criteria (EARS)

- WHEN the scaffold smoke runs, the system SHALL load `@hogsend/plugin-hogsend` from a scaffolded
  app's own `node_modules` under plain `node` using a runtime-assembled specifier, and SHALL fail if
  it does not resolve.
- WHEN the module resolves, the system SHALL assert `createHogsendEmailProvider` is a function
  export, and SHALL fail if it is absent or not callable.
- WHEN the app used for the assertion has no installed dependencies, the system SHALL fail loudly
  rather than skipping the assertion.
- WHEN the assertion is deliberately broken (wrong package name or wrong export name), the smoke
  SHALL fail — mutation-check this before considering the task done.

## Tasks

1. **Make an installed app that carries `plugin-hogsend`.** Either add `hogsend` to the `--with` set
   on the main verified app (which is installed and built) or install `$WITH_DIR`. Prefer whichever
   adds less wall-clock; state which and why in the script comment.
   _Boundary:_ `packages/create-hogsend` · _Depends:_ none

2. **Extend step 7b** to cover `plugin-hogsend` alongside `plugin-apollo`, asserting the named
   factory export for each.
   _Boundary:_ `packages/create-hogsend` · _Depends:_ task 1

3. **Mutation-check both directions** — break the package name, watch it fail; restore. Break the
   export name, watch it fail; restore. Record the evidence in the report.
   _Boundary:_ `packages/create-hogsend` · _Depends:_ task 2

## Seams

None.

## Done when

The scaffold smoke loads `plugin-hogsend` under plain `node` from a real installed app, asserts its
factory export, has been mutation-checked in both directions, and gates are green.

## Implementation Notes

Shipped 2026-08-11 (`2f258054`) as `[~]`, **gate unverified**, which is the whole story of this PRD.

The change itself is small and right: step 7b's assertion was factored into `assert_plugin_loads` and
pointed at both `plugin-apollo` and `plugin-hogsend`, asserting the exact named factory export each
time. The author rejected the cheaper task-1 option (adding `hogsend` to the main app's `--with` set)
because the hogsend env block is genuinely APPENDED to `.env.example` where apollo's dedupes, which
would have broken the existing `diff -q` byte-identity check at line ~340. Independently verified that
claim. **Weakening a live assertion to make a new one cheap is a bad trade**, and refusing it was
correct.

**The assertion has never executed, and must not be assumed working.** `pnpm --filter create-hogsend
verify` dies at step 5 of 10 (`check-types` on the scaffolded app), well before step 7b. So this PRD
closed a gap in a gate that is itself not running to completion.

**What was established about that step-5 failure, so nobody re-derives it:**

- **Not caused by this branch.** It reproduces identically — 33 errors, same files — at the branch
  base `ba42505c`, checked out in a clean worktree with no wave-1 or wave-2 commit present.
- **Not a missing build.** CI runs `pnpm build` before the smoke; re-running locally with a full
  build first fails identically. That was a real procedural error on the orchestrator's part
  (the first two runs skipped it), and correcting it changed nothing.
- **Every error is a zod `.refine((x) => …)` callback losing inference** in engine source
  (`api-keys.ts:127`, `blueprints.ts:206`, and 31 more). It is one root cause, not 33.
- **CI ran this exact step on this exact commit and PASSED** (run 31006118192, 2026-08-05, step
  "Verify scaffold (pack, install, build a real app)"). So it is neither a repo regression nor a
  stable break — something diverges between CI and a local machine.
- **Ruled out:** TypeScript (pinned exactly at `5.9.2`, not a range), `drizzle-orm` (range
  `^4.45.2`-era, nothing published in range since March 2026), and a new stable `zod` (only canaries
  since July, which `^4.4.3` cannot match).
- **Unresolved lead:** the monorepo compiles `moduleResolution: NodeNext` while the scaffold template
  ships `Bundler`, and zod's `exports` map resolves types to `./index.d.cts` behind a custom
  `@zod/source` condition. Different resolution of that map is a plausible mechanism for `.refine`
  inference collapsing, but it is NOT confirmed and does not by itself explain CI passing.

**Why this matters beyond one assertion:** the scaffold smoke is the only gate that packs, installs
and builds a REAL consumer app. If it can be red locally and green in CI, then "CI is green" stops
being evidence that a published scaffold works. That deserves its own investigation, not a footnote
here.
