# DECISIONS — Cloud complexity distillation

Locked global choices every PRD inherits. Settled; do not re-litigate during BUILD.

## Product definition

Two-part distillation of `apps/cloud` (107k LOC Next.js control plane), targeting the
email/SES concern that is ~40% of the app:

1. **PRD 01 (build)** — Lift the two live-AWS diagnostic harnesses (`src/ses-walkthrough/`,
   `src/ses-delivery-proof/`, ~4.3k LOC + ~2.9k LOC tests) out of the deployed app into a
   dedicated dev-only workspace package, so they stop inflating the app's type-check / test /
   build surface and stop reading as runtime code.
2. **PRD 02 (plan only)** — Author the design + extraction PRD for pulling the SES email relay
   behind a `RelayProvider` seam into its own package. **No relay code moves this run.** Output is
   a reviewed spec, not a diff.

## What these harnesses are (context)

- `ses-walkthrough` — a human-run script that runs every SES operation against real AWS AND the
  in-memory `FakeSesClient` side-by-side and reports where they DISAGREE (fake-drift detector).
- `ses-delivery-proof` — a human-run script that sends a real email end-to-end and proves
  delivery/bounce/complaint via the real event path.
- Neither is imported by any runtime code path. Invoked only via `pnpm ses:walkthrough` /
  `pnpm ses:delivery-proof`. They carry ~2.9k LOC of AWS-free unit tests worth keeping.

## Architecture / repo layout

- Monorepo: pnpm workspaces + Turborepo.
- **Harness home = a co-located but excluded subtree `apps/cloud/diagnostics/`**, NOT a separate
  `packages/*` and NOT left in `apps/cloud/src/`. Rationale (evidence-driven): the harnesses
  deep-import app internals — `ses/{types,contract,aws,fake,names,index}`, `substrate/types`, `db`,
  `db/schema`, `lib/{sending-domains,crypto}`, `env`, `services/email-events`. They fundamentally
  *instrument* the app and are not decoupleable. A separate package would force the app to expose a
  new internal-export API (dragging `db`/`env`/`services` into a "diagnostics" package) — that is
  ADDING machinery, the opposite of distillation. Co-located-but-excluded gets them out of the app's
  default gates while keeping the relative imports into `../src/...` that legitimately reflect the
  coupling.
- The `apps/cloud/diagnostics/` path is EXCLUDED from the app tsconfig (`exclude`), the app vitest
  run, and the Next build. It gets its own thin `tsconfig.json` (extends the app's) + `vitest.config`
  so the ~2.9k LOC of AWS-free unit tests still run — invoked explicitly, never as part of
  `apps/cloud`'s default `test`/`check-types`/`build`.
- **The two entry scripts MOVE into `apps/cloud/diagnostics/` — they may NOT stay in
  `apps/cloud/scripts/` and merely repoint their imports.** The app tsconfig includes `**/*.ts`, and
  TS `exclude` only trims root files, not files reachable via `import`. A script left in `scripts/`
  that imports `../diagnostics/src/...` re-pulls the whole excluded tree back into the app's tsc
  program, defeating the exclude. So `scripts/ses-walkthrough.ts` / `scripts/ses-delivery-proof.ts`
  move to `diagnostics/` and the `ses:walkthrough` / `ses:delivery-proof` package.json scripts point
  at their new path.
- **Type-checking is preserved, just relocated.** Excluding the tree from the app gate must NOT mean
  the ~6.7k LOC goes unchecked (vitest runs via esbuild, which does not type-check). The diagnostics
  `tsconfig.json` gets a `diagnostics:check-types` script (`tsc --noEmit -p diagnostics/tsconfig.json`)
  so the tree is still type-checked — under its own command, not the app's.
- **Import-depth rewrite is FOUR distinct transforms, not one** (the harness src sits three dirs below
  `apps/cloud`, the tests two):
  - harness src → app internal: `../ses/*` → `../../../src/ses/*` (pop `ses-walkthrough/`, `src/`, `diagnostics/`)
  - test → app internal: `../db` → `../../src/db` (pop `test/`, `diagnostics/`)
  - test → harness: `../ses-walkthrough` → `../src/ses-walkthrough`
  - harness → harness sibling (`./run`, `../ses-walkthrough/x` within the moved tree): UNCHANGED
- No new workspace package, no `@hogsend/*` name, no publish wiring.

## Stack

Inherits the repo toolchain (DECISIONS never pin versions; install with `pnpm add …@latest` if a
new dep is truly needed — none expected, this is a code move).

- Node 22.x, pnpm 11.12.0, TypeScript, Vitest, Biome, Turborepo.
- No new runtime dependencies expected for PRD 01 (pure relocation + wiring).

## Conventions

- **Conventional Commits**, plain and factual. One commit per task. No `Co-Authored-By`, no AI/vendor
  mention, no marketing.
- **Publish mode: local-commits-only, in the worktree `.claude/worktrees/cloud-distill`
  (branch `refactor/cloud-distill`).** Never push/branch-elsewhere/PR/deploy.
- Behavior-preserving: PRD 01 changes NO runtime behavior. The proof is that the two harness
  commands still run and the relocated tests still pass.

## §4 Quality gates (verbatim commands)

Run from the worktree root. Only gates that exist for the touched surface:

```
pnpm turbo run check-types
pnpm turbo run lint
pnpm turbo run test
pnpm turbo run build
```

Scoped equivalents used during a task (faster inner loop):
```
pnpm --filter @hogsend/cloud check-types
pnpm --filter @hogsend/cloud test
pnpm --filter @hogsend/cloud diagnostics:test         # relocated harness unit tests (standalone vitest)
pnpm --filter @hogsend/cloud diagnostics:check-types  # tsc --noEmit over diagnostics/tsconfig.json
```
(There is NO `@hogsend/ses-diagnostics` workspace package — the diagnostics tree lives inside
`apps/cloud` behind its own scripts.)

**Acceptance for PRD 01:** app gates green AND the relocated diagnostics tests green (via their own
vitest project) AND `apps/cloud/src/ses-walkthrough` + `apps/cloud/src/ses-delivery-proof` no longer
exist AND `grep -rn "ses-walkthrough\|ses-delivery-proof" apps/cloud/src apps/cloud/app` returns
nothing AND `pnpm --filter @hogsend/cloud check-types` no longer type-checks the diagnostics tree
(proven by the exclude) AND both `pnpm ses:walkthrough --help` / `pnpm ses:delivery-proof --help`
still run.

## Seams

- **Real AWS** — never exercised by gates. The harnesses only run against real AWS when a human
  passes `--i-know-this-hits-aws`. CI/gates exercise only their AWS-free unit tests against the fake.
  This is a pre-existing seam; PRD 01 preserves it, does not resolve it.

## Publish mode

`local-commits-only` — commit locally in the worktree; never push.
