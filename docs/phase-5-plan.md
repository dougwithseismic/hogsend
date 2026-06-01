# Phase 5 — Eject / Patch Tooling + Docs (Implementation Plan)

> Status: PLAN ONLY. Nothing here is implemented yet. This document is the
> concrete, file-by-file build plan for Phase 5 of
> `docs/TODO-packages-migration.md` (the "Eject / Patch Tooling + Docs" phase,
> Risk: LOW). It is specific to THIS codebase as it stands on 2026-05-31.

**Goal of the phase.** Give a client three escalating ways to change engine
behaviour, each with a documented upgrade cost:

1. **Extend** (zero upgrade cost) — the injection seams already shipped in
   Phase 1 (`createContainer`/`createApp`/`createWorker` + `defineJourney`/
   `defineWebhookSource`).
2. **Patch** (`pnpm patch @hogsend/engine`) — surgical fix, re-applies on
   install, fails loudly on upstream conflict.
3. **Eject** (`hogsend eject @hogsend/engine`) — copy the package source into
   `vendor/engine`, rewrite the consumer dep to a `file:` link; that one package
   stops auto-upgrading, everything else still `pnpm up`s.

Phase 5 must deliver (a) the docs for all three rungs, and (b) a tested `eject`
tool. Per the TODO, if a full out-of-monorepo sandbox proof is impractical in
this run, ship the tooling + a unit test of the eject file operations and
document the manual sandbox steps for Patch and Eject.

---

## 0. Current-state facts this plan is built on (verified)

- The npm-package monorepo: `packages/{core,db,email,engine,plugin-posthog,plugin-resend,typescript-config}` + `apps/{api,docs}`. `pnpm-workspace.yaml` globs `apps/*` and `packages/*`.
- `@hogsend/engine` (`packages/engine/package.json`, version `0.0.1`, `private:true`) ships **raw `.ts`** via `exports: { ".": "./src/index.ts", "./worker": "./src/worker.ts" }`, bundled by consumers through tsup `noExternal` (`packages/engine/tsup.config.ts` lists all five `@hogsend/*` deps). Public surface = `packages/engine/src/index.ts`.
- `apps/api` (`@hogsend/api`) depends on `@hogsend/engine` (and the other four `@hogsend/*`) at `workspace:^`. It is the dogfood consumer and the only workspace with a vitest suite (`apps/api/src/__tests__/`, 9 files; the task notes ~102 tests there + a 6-test `migration-system.test.ts` and `enrollment-guards.test.ts`).
- vitest config (`apps/api/vitest.config.ts`) injects env vars and **inlines `@hogsend/engine`** so Vite resolves its `.js`-extensioned relative imports against the raw `.ts` sources. Tests run with `pnpm --filter @hogsend/api test`.
- There is already a **Go CLI** at `cli/` (cobra: `init/deploy/status/contacts/journeys/...`). It is an **ops** tool (Railway deploy, PostHog, health) and is NOT a pnpm workspace and NOT involved in npm-package manipulation. **Decision: `eject` does NOT go in the Go CLI.** It manipulates `package.json`/`node_modules`/`vendor/` in a Node monorepo, so it belongs in a small Node workspace package. See Decision E1 below.
- `.changeset/config.json` is configured (public access, baseBranch `main`, per-package CHANGELOG). Root `package.json` already has `@changesets/cli`.
- No `patches/` dir and no `vendor`/`patches` lines in `.gitignore` yet.
- `create-hogsend` does NOT exist yet (it is Phase 3 work, not done). This plan therefore does NOT depend on it; the eject tool lives in its own package and the docs reference create-hogsend's future README only as a pointer.

---

## 1. Decisions to lock for this phase

- **E1 — Where `eject` lives.** Create a new published Node workspace package
  **`@hogsend/cli`** at `packages/cli/`, ESM, Node 22, raw `.ts` consumed via
  tsup like the others, with a `bin` entry `hogsend` mapping to a thin
  `src/bin.ts`. Subcommand: `hogsend eject <pkg>`. Rationale: the Phase 5 task
  text explicitly offers "a small @hogsend/cli"; the Go `cli/` is ops-only;
  create-hogsend doesn't exist yet, and we don't want to block Phase 5 on Phase
  3. The core logic is a **pure, unit-testable** function so the bin is a
  trivial wrapper. (If/when create-hogsend ships in Phase 3, it can re-export
  `@hogsend/cli`'s `eject()` — noted as a follow-up, not built here.)
- **E2 — Vendor layout & dep rewrite.** Eject copies `packages/<name>/` →
  `vendor/<name>/` (e.g. `vendor/engine/`) in the **consumer's** repo root and
  rewrites the consumer `package.json` dependency from `"@hogsend/engine":
  "workspace:^"` (in-monorepo) or a semver range (in a scaffolded app) to
  `"@hogsend/engine": "file:./vendor/engine"`. All other `@hogsend/*` deps are
  left untouched so they keep resolving from the registry/workspace and stay
  `pnpm up`-able. This satisfies the invariant: "Eject one package; the rest
  still upgrade."
- **E3 — What gets copied.** Copy the package's distributable source: `src/`,
  `package.json`, `tsup.config.ts`, `tsconfig.json`, plus `drizzle/` only when
  ejecting `@hogsend/db`. **Exclude** `node_modules`, `dist`, `.turbo`,
  `.changeset`, `*.test.ts`, and `CHANGELOG.md`. The copied `package.json` is
  rewritten so its `name` is unchanged (still `@hogsend/engine`) but `private`
  is dropped/forced (it's now a local file dep) — exact field handling spelled
  out in §3.2.
- **E4 — Idempotency & safety.** `eject` refuses to clobber an existing
  `vendor/<name>/` unless `--force`. It is a no-op-safe second run only with
  `--force`. It validates the target dep exists in the consumer `package.json`
  before doing anything; otherwise exits non-zero with a clear message. It never
  runs `pnpm install` itself (prints the follow-up command for the operator) —
  keeps the unit under test pure and avoids touching the lockfile in CI.
- **E5 — Patch proof shape.** A real `pnpm patch` cycle mutates `node_modules`
  and writes a `patches/*.patch` + a `pnpm.patchedDependencies` block. Per the
  TODO's "can be a documented + scripted check," Phase 5 ships a **scripted
  check** (`packages/cli/scripts/patch-check.sh`) that asserts (1) a committed
  patch re-applies on a clean `pnpm install` and (2) a deliberately conflicting
  patch makes install fail loudly. This script is documented and runnable but is
  NOT wired into the always-on CI gate (it needs a network/registry install);
  it's an on-demand proof. Eject is proven by a vitest unit test that runs in
  the normal suite.

---

## 2. Docs deliverable — the Extend → Patch → Eject ladder

### 2.1 New doc: `docs/customizing-the-engine.md`

Authoritative ladder doc. Sections:

1. **Overview table** — the three rungs with "when to use / how / upgrade cost,"
   mirroring the table at `docs/packages-migration-plan.md` lines ~22–24 and the
   "Editability ladder" in `docs/TODO-packages-migration.md` lines ~90–93. Keep
   wording consistent with those so the canon doesn't drift.
2. **Extend (preferred, cost: none).** Enumerate the exact injection seams,
   quoting the real signatures from `docs/engine-boundary.md` §"Engine public
   API" and `packages/engine/src/index.ts`:
   - `createContainer({ journeys, enabledJourneys?, overrides })` where
     `overrides = { emailService?, posthog?, auth?, hatchet? }`.
   - `createApp(container, { routes?, middleware?, webhookSources?, onError? })`.
   - `createWorker({ container, journeys, workflows? })`.
   - `defineJourney({ meta, run })` and `defineWebhookSource(...)`.
   - Concrete "I want to X → extend via Y" recipes: add a journey, add a
     webhook source, add a custom route, swap the email service, override the
     PostHog client, add middleware. Link `docs/engine-boundary.md`.
3. **Patch (cost: re-applies on install; loud on conflict).** Exact commands:
   ```
   pnpm patch @hogsend/engine          # opens an editable copy in a temp dir
   #  …edit the files…
   pnpm patch-commit <printed-path>    # writes patches/@hogsend__engine@<ver>.patch
   ```
   Explain the generated `pnpm.patchedDependencies` block in `package.json`, that
   the `.patch` file MUST be committed, that pnpm re-applies it on every install,
   and that on an engine upgrade where the patched lines moved, **install fails
   loudly** ("Could not apply patch … to …") — the built-in upgrade-conflict
   signal. Guidance: keep patches tiny and line-local; if a patch keeps
   conflicting, escalate to Eject. Point to the scripted proof
   (`packages/cli/scripts/patch-check.sh`) and the manual sandbox steps (§5.2).
4. **Eject (cost: you fork that one package).** Document
   `pnpm hogsend eject @hogsend/engine` (or `pnpm dlx @hogsend/cli eject …` in a
   scaffolded app): what it copies (§E3), the `file:./vendor/engine` rewrite
   (§E2), the `--force` flag, and the required follow-up `pnpm install`. State
   the upgrade contract: the ejected package no longer tracks upstream (you merge
   engine changes by hand into `vendor/engine`), but **every other `@hogsend/*`
   still `pnpm up`s normally**, and the two-track migration story is unaffected
   (engine migrations still ship from whatever `@hogsend/db` you resolve). Add a
   short "how to un-eject" note (delete `vendor/engine`, restore the dep range,
   reinstall).
5. **Decision guide** — fl/owchart-in-prose: try Extend; if you must touch
   internals for a small fix, Patch; if you're rewriting internals or your patch
   won't stop conflicting, Eject. Cross-link `docs/UPGRADING.md` (the upgrade
   contract the ladder sits inside) and `docs/engine-boundary.md` (the seams).

### 2.2 Cross-links to update

- `docs/TODO-packages-migration.md`: tick the Phase 5 doc checkbox and point its
  "Document the Extend → Patch → Eject ladder" line at
  `docs/customizing-the-engine.md` (edit the existing line ~216).
- `docs/UPGRADING.md`: add a short "If you've patched or ejected" subsection
  under Rollback policy linking the new doc (mirrors plan lines ~194–195).
- `README.md`: one line under the customizing/upgrade section pointing to the
  new doc (optional, low priority).

---

## 3. Tooling deliverable — `@hogsend/cli` with `eject`

### 3.1 New package scaffold `packages/cli/`

Files to create:

- `packages/cli/package.json`:
  - `"name": "@hogsend/cli"`, `"version": "0.0.1"`, `"type": "module"`,
    `"engines": { "node": ">=22" }`. NOT `private` (it will publish, like the
    other `@hogsend/*`). `"bin": { "hogsend": "./dist/bin.js" }`.
  - `"exports": { ".": "./src/index.ts", "./eject": "./src/eject.ts" }` (raw
    `.ts` like the rest; tsup builds `dist/` for the published bin).
  - `scripts`: `build` (tsup), `check-types` (`tsc --noEmit`),
    `lint` (`biome check .`), `clean`.
  - deps: none beyond Node builtins for the core logic; devDeps
    `@repo/typescript-config`, `@types/node`, `tsup`, `tsx`, `vitest`. Add via
    `pnpm --filter @hogsend/cli add -D <pkg>@latest` (never hand-edit ranges).
- `packages/cli/tsup.config.ts`: entry `["src/bin.ts", "src/index.ts"]`,
  `format:["esm"]`, `target:"node22"`, `clean:true`, `splitting:false`,
  `sourcemap:true`. No `noExternal` needed (zero `@hogsend/*` deps).
- `packages/cli/tsconfig.json`: extend `@repo/typescript-config` base like the
  other packages.
- `packages/cli/src/bin.ts`: `#!/usr/bin/env node` shebang; arg parse (no dep —
  hand-roll, or `node:util` `parseArgs`); dispatch `eject` subcommand; print
  usage on unknown/`--help`; `process.exit(code)` from the result.
- `packages/cli/src/index.ts`: re-export `eject`, `EjectOptions`,
  `EjectResult` from `./eject.js`.
- `packages/cli/src/eject.ts`: the pure logic (below).

No `pnpm-workspace.yaml` change needed — `packages/*` already globs it in.

### 3.2 `eject.ts` — function signatures (exact)

Designed pure and filesystem-injectable so the unit test runs in a temp dir with
zero side effects on the repo.

```ts
export interface EjectOptions {
  /** scoped package name to eject, e.g. "@hogsend/engine" */
  pkg: string;
  /** consumer repo root (dir containing the consumer package.json) */
  consumerRoot: string;
  /**
   * where the package source currently lives (the workspace/registry copy).
   * In-monorepo: <repoRoot>/packages/<name>. In a scaffolded app it is the
   * resolved node_modules path. Caller resolves this; eject() does not guess.
   */
  sourceDir: string;
  /** overwrite an existing vendor/<name> */
  force?: boolean;
}

export interface EjectResult {
  pkg: string;
  vendorPath: string;        // absolute path to vendor/<name>
  depSpecBefore: string;     // e.g. "workspace:^"
  depSpecAfter: string;      // "file:./vendor/<name>"
  copiedFiles: number;
  /** the install command the operator must run next */
  followUp: string;          // "pnpm install"
}

export async function eject(opts: EjectOptions): Promise<EjectResult>;
```

Behaviour, step by step (each step a named internal helper so the test can also
target them if useful):

1. **Resolve names.** `vendorName = opts.pkg.split("/").pop()` (→ `engine`).
   `vendorPath = join(consumerRoot, "vendor", vendorName)`.
2. **Validate consumer dep.** Read `consumerRoot/package.json`. If `opts.pkg`
   is not present in `dependencies` (nor `devDependencies`), throw
   `EjectError("`<pkg>` is not a dependency of the consumer package.json")`.
   Record `depSpecBefore` and which dep map it lived in.
3. **Guard vendor dir.** If `vendorPath` exists and `!force`, throw
   `EjectError("vendor/<name> already exists; pass --force to overwrite")`.
   If `force`, `rm -rf` it first.
4. **Copy source** with an exclude filter (E3): skip `node_modules`, `dist`,
   `.turbo`, `.changeset`, `CHANGELOG.md`, any `*.test.ts`. Implement via
   `fs.cp(sourceDir, vendorPath, { recursive: true, filter })` (Node 22 has
   `fs.cp` with a `filter` predicate). Count copied files for `copiedFiles`.
5. **Rewrite vendored package.json.** Load `vendorPath/package.json`; if it has
   `"private": true`, delete that key (a `file:` dep should be installable).
   Leave `name`/`version`/`exports`/`dependencies` intact (its `@hogsend/*`
   deps still resolve from the consumer's node_modules). Write back with a
   trailing newline, 2-space indent (matches Biome/repo style).
6. **Rewrite consumer dep.** Set the entry in the original dep map to
   `file:./vendor/<name>`. Preserve key ordering by mutating in place. Write
   back `consumerRoot/package.json` with 2-space indent + trailing newline.
7. **Return `EjectResult`** with `followUp: "pnpm install"`. The bin prints a
   success block: what was copied, the rewrite, and "Now run: pnpm install".

`EjectError extends Error` for typed failures; the bin maps it to exit code 1
with a red one-line message (no stack).

### 3.3 Bin resolution of `sourceDir`

`bin.ts` resolves `sourceDir` before calling `eject()`:
- Default `consumerRoot = process.cwd()`.
- Try `require.resolve`-style: locate the installed package via
  `node:module`'s `createRequire(consumerRoot + "/")` → `resolve("<pkg>/package.json")`
  → `dirname`. This finds it under `node_modules/.pnpm/...` or a workspace
  symlink. If resolution fails, error out telling the user the package isn't
  installed.
- Keeping resolution in `bin.ts` (not `eject.ts`) keeps `eject()` pure and the
  unit test hermetic.

---

## 4. Tests — exact additions and assertions

### 4.1 Unit test (always-on, in the normal suite)

New file: `packages/cli/src/__tests__/eject.test.ts` (vitest). To run it in the
existing gate, add a minimal `packages/cli/vitest.config.ts`
(`test.include: ["src/**/*.test.ts"]`, environment `node` — no env injection
needed) and a `"test": "vitest run"` script in `packages/cli/package.json`. The
root `turbo run test` will then pick it up; the task's `pnpm --filter
@hogsend/api test` stays unchanged and green.

Test setup: each test makes a throwaway temp dir via `fs.mkdtemp(os.tmpdir())`
and `afterEach` `rm -rf`s it. It fabricates:
- a fake `sourceDir` (`<tmp>/src-pkg/`) containing `package.json`
  (`{ name:"@hogsend/engine", version:"0.0.1", private:true, exports:{...},
  dependencies:{ "@hogsend/core":"workspace:^" } }`), `src/index.ts`,
  `src/lib/db.ts`, a `node_modules/junk.js`, a `dist/old.js`, and a
  `src/foo.test.ts`.
- a fake `consumerRoot` (`<tmp>/consumer/`) with `package.json`
  (`dependencies: { "@hogsend/engine":"workspace:^", "@hogsend/core":"workspace:^" }`).

Assertions:
1. **Happy path copies the right files.** After `eject({pkg, consumerRoot,
   sourceDir})`: `vendor/engine/src/index.ts` and `vendor/engine/src/lib/db.ts`
   exist; `vendor/engine/package.json` exists.
2. **Excludes are honored.** `vendor/engine/node_modules` does NOT exist,
   `vendor/engine/dist` does NOT exist, `vendor/engine/src/foo.test.ts` does NOT
   exist.
3. **Consumer dep rewritten, others untouched.** Re-read `consumer/package.json`:
   `dependencies["@hogsend/engine"] === "file:./vendor/engine"` and
   `dependencies["@hogsend/core"] === "workspace:^"` (unchanged — proves "other
   `@hogsend/*` still resolve normally," the core Eject invariant).
4. **Vendored package.json sanitized.** `vendor/engine/package.json` has no
   `private` key, keeps `name === "@hogsend/engine"`, keeps its
   `dependencies["@hogsend/core"]`.
5. **Result object.** `result.depSpecBefore === "workspace:^"`,
   `result.depSpecAfter === "file:./vendor/engine"`,
   `result.followUp === "pnpm install"`, `result.copiedFiles >= 3`.
6. **Refuses to clobber without --force.** Second `eject(...)` (vendor exists)
   `await expect(...).rejects.toThrow(/already exists/)`.
7. **--force overwrites.** With `force:true`, second run succeeds and a file
   removed from `sourceDir` between runs is absent in `vendor/engine`.
8. **Missing dep errors loudly.** `consumerRoot` whose `package.json` lacks
   `@hogsend/engine` → `rejects.toThrow(/not a dependency/)`, and assert NO
   `vendor/` dir was created (fails before any copy).

### 4.2 Scripted Patch proof (on-demand, documented)

New file: `packages/cli/scripts/patch-check.sh` (bash, `set -euo pipefail`).
Operates in a temp throwaway dir (NOT the dev DB, NOT the repo). It:
1. Creates a tiny consumer that depends on a real published-or-packed
   `@hogsend/engine` (or, for in-repo runs, uses `pnpm pack` of
   `packages/engine` to a tarball and installs that — no registry needed).
2. `pnpm patch @hogsend/engine`, edits a known line in
   `node_modules/.../src/<file>.ts` (e.g. a string literal in
   `routes/health.ts`), `pnpm patch-commit`.
3. **Assert re-apply:** `rm -rf node_modules && pnpm install` → exit 0, and the
   edited string is present in the reinstalled file (`grep`).
4. **Assert loud conflict:** rewrite the tarball's targeted line (simulate an
   upstream change), bump version, reinstall → expect `pnpm install` to
   **fail** with a patch-apply error; the script asserts non-zero exit and that
   stderr matches `/Could not apply patch|patch.*failed/i`.
5. Prints PASS/FAIL summary; exits non-zero on any failed assertion.

Documented in `docs/customizing-the-engine.md` §Patch and runnable via
`bash packages/cli/scripts/patch-check.sh`. NOT added to the always-on CI gate
(needs an install); listed as an on-demand verification.

### 4.3 Eject sandbox proof (documented manual steps; optional scripted)

`docs/customizing-the-engine.md` §Eject documents the manual proof and, if time
permits, `packages/cli/scripts/eject-check.sh` mirrors it: in a temp consumer,
run the built `hogsend eject @hogsend/engine`, `pnpm install`, `pnpm build` (or
`tsc --noEmit`) → succeeds importing from `vendor/engine`; then
`pnpm up @hogsend/core` still bumps core. If a full out-of-monorepo sandbox is
impractical this run (no published packages until Phase 4), the §4.1 unit test
is the binding proof of the file operations and the manual steps are documented
verbatim. This matches the TODO's explicit fallback.

---

## 5. Build / wiring details

### 5.1 Repo plumbing
- `.gitignore`: add `vendor/` is NOT added at the monorepo root (we do not eject
  in-repo); instead the **scaffolded app template** (Phase 3) will commit
  `vendor/` deliberately. Document this; do not touch root `.gitignore` beyond
  ignoring `packages/cli/dist` (covered by existing `dist` patterns if present —
  verify and add if not).
- `turbo.json`: no change required; `@hogsend/cli` picks up `build`/`test`/
  `check-types` from the existing task graph by virtue of being a workspace with
  those scripts.
- Add a changeset entry for the new `@hogsend/cli` package (`pnpm changeset`,
  minor for a new package) — gated, not published (publishing is Phase 4 /
  dry-run only per guardrails).

### 5.2 Manual sandbox steps (documented in the new doc)
Spell out, copy-pasteable: (1) `pnpm pack` the engine to a tarball; (2) create a
clean dir outside the monorepo, `pnpm init`, install the tarball; (3) run the
Patch cycle and the Eject command; (4) the exact greps/builds that constitute
PASS. These are the human-runnable equivalents of §4.2/§4.3.

---

## 6. Order of work

1. Write `docs/customizing-the-engine.md` (§2) + cross-link edits (§2.2).
2. Scaffold `packages/cli/` (§3.1), add deps via `pnpm add`.
3. Implement `eject.ts` (§3.2) + `index.ts` + `bin.ts` (§3.3).
4. Write `eject.test.ts` + `vitest.config.ts` (§4.1); make it green.
5. Write `patch-check.sh` (§4.2) and (optional) `eject-check.sh` (§4.3).
6. Add changeset; run the full verification gate (§7); commit (no push).

---

## 7. Verification checklist (mirrors the TODO's Phase 5 Verify/Success)

From `docs/TODO-packages-migration.md` lines ~220–222:

- [ ] **Ladder documented.** `docs/customizing-the-engine.md` covers Extend
  (real seams from `engine-boundary.md`), Patch (`pnpm patch @hogsend/engine`
  cycle), and Eject (`hogsend eject @hogsend/engine` → `vendor/engine` +
  `file:` rewrite), with the decision guide and cross-links. TODO Phase 5 doc
  checkbox ticked.
- [ ] **Eject tool implemented & scoped.** `@hogsend/cli` `eject()` copies one
  package into `vendor/<name>` and rewrites only that consumer dep to
  `file:./vendor/<name>`; all other `@hogsend/*` deps left intact.
- [ ] **Eject unit-tested.** `eject.test.ts` green: copies correct files,
  honors excludes, rewrites only the target dep, sanitizes vendored
  package.json, returns the right result, refuses clobber w/o `--force`,
  overwrites with `--force`, errors loudly on a missing dep — all 8 assertions
  in §4.1 pass.
- [ ] **Patch proof:** `packages/cli/scripts/patch-check.sh` demonstrates the
  patch re-applies on a clean install AND fails loudly on an upstream conflict
  (scripted check per the TODO's allowance), plus manual steps documented.
- [ ] **Eject proof:** ejected `@hogsend/engine` builds from `vendor/engine`
  while `pnpm up @hogsend/core` still upgrades the non-ejected package — proven
  by the unit test's dep-isolation assertion (#3) and the documented/scripted
  sandbox steps.
- [ ] **Gate green throughout (from repo root):**
  - [ ] `pnpm check-types`
  - [ ] `pnpm build` (now includes `@hogsend/cli`)
  - [ ] `pnpm lint` (Biome: 2-space, double quotes, semicolons, 80-col)
  - [ ] `pnpm --filter @hogsend/api test` — still **102 green** (unchanged; no
    edits to `apps/api`).
  - [ ] `pnpm --filter @hogsend/cli test` — new eject unit suite green.
- [ ] **Guardrails respected:** no `git push`; no AI/Anthropic in commit
  messages; no npm publish (changeset added, publish remains Phase 4 / dry-run);
  no Railway / prod / shared-dev-DB schema mutation. Eject is filesystem-only on
  throwaway temp dirs in tests.

---

## 8. Risks & mitigations

- **R1 — `eject` belonging in the Go CLI vs a JS package.** Resolved by E1: Go
  CLI is ops-only and not a pnpm workspace; npm-package manipulation must be
  Node. Risk: two CLIs named `hogsend` (Go binary on PATH vs `@hogsend/cli`
  bin). Mitigation: document that the npm `hogsend eject` is invoked via
  `pnpm hogsend eject …` / `pnpm dlx @hogsend/cli eject …` inside a project,
  distinct from the globally-installed Go ops binary; revisit unifying them
  post-1.0.
- **R2 — `fs.cp` `filter` semantics.** The predicate is called per source path;
  returning `false` for a directory prunes the whole subtree. Must test that
  `node_modules`/`dist` pruning works (covered by §4.1 #2). Node 22 supports
  this; pin behaviour with the unit test.
- **R3 — Patch proof needs an installable engine.** Until Phase 4 publishes,
  the script must `pnpm pack` the local engine to a tarball; document that the
  script is in-repo-pack-based, not registry-based, so it runs today. If
  packing the raw-`.ts` engine surfaces resolution issues for a `file:`/tarball
  consumer, fall back to the documented manual steps + the unit test as the
  binding proof (TODO explicitly allows this).
- **R4 — Vendored raw-`.ts` engine must still build for the consumer.** The
  engine ships `.ts` and relies on the consumer's tsup `noExternal`. When
  ejected to `vendor/engine` as a `file:` dep, the consumer's tsup must still
  bundle it. Mitigation: the eject-check/manual step builds the consumer to
  confirm; document that consumers keep `@hogsend/engine` in their tsup
  `noExternal` even after eject (the package name is unchanged).
- **R5 — create-hogsend not existing yet.** This plan deliberately does not
  depend on Phase 3; `eject` lives standalone in `@hogsend/cli`. Follow-up note
  recorded: when create-hogsend ships, have it re-export `eject()` and add
  `vendor/` handling to the template — out of Phase 5 scope.
