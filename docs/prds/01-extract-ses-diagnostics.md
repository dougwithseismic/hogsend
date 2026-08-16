# PRD 01 — Extract the SES diagnostic harnesses out of the app (build)

## Goal

Move `apps/cloud/src/ses-walkthrough/` and `apps/cloud/src/ses-delivery-proof/` (+ their two test
files) into a co-located but build/type-check/test-excluded subtree `apps/cloud/diagnostics/`, so
they stop inflating the app's gates and stop reading as runtime code. **Zero runtime behavior change.**

## Locked decisions (specific to this PRD)

- Destination: `apps/cloud/diagnostics/` with `src/` (the two harness dirs) and `test/` (the two
  test files + `helpers/ses-notifications`).
- Imports into the app stay RELATIVE. Do not invent an export API. The coupling is real and honest.
  **The rewrite is FOUR distinct depth transforms — do NOT apply one blanket rule** (see DECISIONS
  "Import-depth rewrite is FOUR distinct transforms"):
  - harness src → app internal: `../ses/*` → `../../../src/ses/*` (three levels up)
  - test → app internal: `../db` → `../../src/db` (two levels up)
  - test → harness: `../ses-walkthrough` → `../src/ses-walkthrough`
  - harness → harness sibling: UNCHANGED
- **The two entry scripts MOVE into `diagnostics/`** (not left in `scripts/` with repointed imports —
  that re-drags the excluded tree into the app's tsc program). `ses:walkthrough` /
  `ses:delivery-proof` package.json scripts point at the moved paths.
- The subtree is excluded from: app `tsconfig.json` `exclude`, app `vitest.config` (test exclude),
  and the Next build. Confirm Next never compiles it.
- The subtree gets `apps/cloud/diagnostics/tsconfig.json` (extends `../tsconfig.json`, includes only
  itself) and `apps/cloud/diagnostics/vitest.config.ts` so its tests run standalone.
- Add `diagnostics:test` (standalone vitest) AND `diagnostics:check-types`
  (`tsc --noEmit -p diagnostics/tsconfig.json`) scripts. Type-checking is PRESERVED for the tree,
  just under its own command — vitest/esbuild does not type-check, so without this the 6.7k LOC would
  silently go unchecked. Do NOT fold either back into the app's default `test`/`check-types`.

## EARS acceptance criteria

- WHEN `pnpm --filter @hogsend/cloud check-types` runs, the system SHALL NOT type-check any file
  under `apps/cloud/diagnostics/`.
- WHEN `pnpm --filter @hogsend/cloud test` runs, the system SHALL NOT execute the diagnostics tests.
- WHEN `pnpm --filter @hogsend/cloud build` runs, the system SHALL succeed and produce no diagnostics
  code in the output.
- WHEN the diagnostics test project runs (`pnpm --filter @hogsend/cloud diagnostics:test`), the system
  SHALL execute the relocated walkthrough + delivery-proof unit tests and they SHALL pass.
- WHEN `pnpm --filter @hogsend/cloud diagnostics:check-types` runs, the system SHALL type-check the
  entire relocated tree with no errors (type-checking preserved, not dropped).
- WHEN `pnpm ses:walkthrough --help` or `pnpm ses:delivery-proof --help` runs, the system SHALL print
  the help text exactly as before (command still wired).
- WHEN `grep -rn "ses-walkthrough\|ses-delivery-proof" apps/cloud/src apps/cloud/app` runs, the
  system SHALL return no matches.

## Task breakdown

- **T1 — Relocate files.** `git mv apps/cloud/src/ses-walkthrough apps/cloud/diagnostics/src/ses-walkthrough`
  and same for `ses-delivery-proof`; move the two test files + `src/__tests__/helpers/ses-notifications`
  they use into `apps/cloud/diagnostics/test/`; move `scripts/ses-walkthrough.ts` +
  `scripts/ses-delivery-proof.ts` into `apps/cloud/diagnostics/`. Apply the FOUR distinct
  import-depth transforms (see locked decisions) — harness src → app = three `../`, test → app =
  two `../`, test → harness = `../src/…`, sibling = unchanged. Verify by grepping the moved tree for
  any `../../src` inside a harness-src file (should be `../../../src`) and any stray unresolved path.
  _Boundary:_ `apps/cloud`. _Depends:_ none.
- **T2 — Standalone tsconfig + vitest for the subtree.** Add `apps/cloud/diagnostics/tsconfig.json`
  (extends app tsconfig, `include` = diagnostics only) and `apps/cloud/diagnostics/vitest.config.ts`
  (reuses the app's test env injection). Add `diagnostics:test` AND `diagnostics:check-types`
  (`tsc --noEmit -p diagnostics/tsconfig.json`) scripts to `apps/cloud/package.json`, plus repoint
  `ses:walkthrough` / `ses:delivery-proof` to the moved entry scripts. _Boundary:_ `apps/cloud`.
  _Depends:_ T1.
- **T3 — Exclude from app gates.** Add `apps/cloud/diagnostics` to the app `tsconfig.json` `exclude`
  and to the app `vitest.config.ts` test `exclude`. Confirm Next build ignores it AND that
  `pnpm --filter @hogsend/cloud check-types` no longer pulls the tree in via any import (no residual
  importer in `src`/`scripts`). _Boundary:_ `apps/cloud`. _Depends:_ T1, T2.
- **T4 — Verify parity.** Run all app gates green; run `diagnostics:test` green; run both harness
  `--help` commands; run the grep. Confirm no runtime code path changed (the harnesses were never
  imported by runtime — reassert with the grep over `src`/`app`). _Boundary:_ `apps/cloud`.
  _Depends:_ T1–T3.

## Seams

- Real AWS remains a seam (harnesses only hit it with `--i-know-this-hits-aws`); gates never touch it.
  Not resolved here — preserved.

## Done when

All EARS criteria pass; app gates green; diagnostics tests green standalone; one commit.

## Implementation Notes

- Relocated via `git mv` (24 files rename-tracked): `src/ses-walkthrough/` + `src/ses-delivery-proof/`
  → `diagnostics/src/`; the 2 test files → `diagnostics/test/`; the 2 entry scripts
  `scripts/ses-{walkthrough,delivery-proof}.ts` → `diagnostics/`.
- Four distinct import-depth transforms applied (harness-src→app = `../../../src`, test→app =
  `../../src`, test→harness = `../src`, siblings unchanged; entry scripts `../src/…` → `./src/…`).
  A multi-line dynamic `await import("../ses-delivery-proof/stub-instance")` in the delivery-proof
  test was also caught and repointed.
- **Coupling the PRD missed:** `src/__tests__/ses-tenants.test.ts` (stays in the app) imported
  `WALKTHROUGH_PUBLISHED_EVENT_TYPES` from the harness — this would have kept the audit grep
  non-empty AND dragged the excluded tree back into the app's tsc program. Fix: the single
  drift-guard `it` block (pins the harness's event-type copy against `SES_PUBLISHED_EVENT_TYPES`)
  moved into `diagnostics/test/ses-walkthrough.test.ts` (its natural home); zero assertion lost, now
  runs under `diagnostics:test`.
- Shared helper `src/__tests__/helpers/ses-notifications.ts` was NOT moved — it's also used by two
  other app tests AND runtime `src/lib/ses-events.ts`; the diagnostics test repoints to it at
  `../../src/__tests__/helpers/ses-notifications`.
- `diagnostics/tsconfig.json` pins `baseUrl` + `paths` (`@/*` → `../*`) so `diagnostics:check-types`
  resolves the `@/` alias deterministically (base declares no `baseUrl`). `diagnostics/vitest.config.ts`
  sets `root` to the diagnostics dir (so `test.include` resolves there, not cwd) and mirrors the app's
  test-env injection verbatim.
- **Gates (orchestrator-run, all green):** app `check-types` ✓ · `diagnostics:check-types` ✓ · Biome
  ✓ (8 auto-fixed import-sort nits) · `diagnostics:test` 98/98 ✓ · app `test` 1710/1710 ✓ (2 harness
  files no longer in the app run) · app `build` ✓ · both harness `--help` ✓. Zero runtime behavior
  change.
- **Bonus finding for PRD 03:** `ses-delivery-proof` ALREADY sends only to the SES mailbox simulator
  (`--help`: "Recipients are FIXED to the simulator… no flag can aim this at a real inbox"). PRD 03's
  simulator-adoption work is therefore largely the walkthrough side; delivery-proof already complies.
