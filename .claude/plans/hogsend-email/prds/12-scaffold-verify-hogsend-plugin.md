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
