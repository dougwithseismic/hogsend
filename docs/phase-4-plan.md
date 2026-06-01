# Phase 4 — Publish Pipeline (DRY-RUN ONLY) — Implementation Plan

> Status: **PLAN. Nothing implemented.** This document is the concrete,
> codebase-specific build sheet for Phase 4 of the packages migration
> (`docs/TODO-packages-migration.md` lines 195–208). It depends on Phases 0–3.
>
> **Hard guardrail for this phase: NEVER publish for real, NEVER `git push`,
> NEVER touch Railway / prod / live DBs.** Every publish/version command below is
> a dry-run or runs against a scratch copy that is reverted. The real package
> versions in this repo must be byte-identical before and after the test pass.

---

## 0. What Phase 4 actually has to produce

1. A **changesets release GitHub Actions workflow** (`.github/workflows/release.yml`)
   that, *only in CI on merge to `main`*, version-bumps from accumulated
   changesets, publishes the publishable `@hogsend/*` packages + `create-hogsend`
   to public npm, pushes git tags, and writes per-package `CHANGELOG.md`.
2. The seven publishable packages made **actually publishable** (drop `private`,
   fix `publishConfig`, `files`, `exports`/`main`/`types`, `repository`,
   `license`) while keeping `apps/*` and `@repo/typescript-config`'s consumers
   correct. **Crucially:** `@hogsend/db` must ship its `drizzle/` migration folder
   in the tarball, because the migrator loads SQL from disk at runtime
   (`new URL("../drizzle", import.meta.url)` — `packages/db/src/migrate.ts:13`).
3. A **`docs/RELEASING.md`** that codifies semver discipline and the rule that
   engine migrations ship versioned with `@hogsend/db` / `@hogsend/engine`; plus
   a short cross-link added to `docs/UPGRADING.md`.
4. A confirmation (test, not new code) that `/docs` + `/openapi.json` stay
   disabled when `NODE_ENV=production` — already true at
   `packages/engine/src/app.ts:73` (`if (container.env.NODE_ENV !== "production")`).

> **Publish model (locked by the migration plan, do not change here):** the
> migration plan (`docs/packages-migration-plan.md` §10, and the TODO Notes
> "tsup `noExternal`") keeps the existing bundling model — consumers bundle
> `@hogsend/*` via tsup `noExternal`. Therefore the publishable packages ship
> **raw `.ts` source** (their current `exports` point at `./src/*.ts`), not a
> compiled `dist/`. `apps/api`'s `tsup.config.ts` already `noExternal`s every
> `@hogsend/*` (and `create-hogsend`'s scaffolded app will do the same). This
> means **no new build step is required for core/db/engine to be publishable** —
> but `files` must include `src/` (+ `drizzle/` for db, `emails/` for email) so
> the source travels in the tarball. This decision is recorded explicitly in
> `docs/RELEASING.md`. (If a future phase wants compiled output, that is a
> separate change to `exports`/`tsup` — out of scope for Phase 4.)

---

## 1. Pre-flight: current state (verified, do not re-discover)

- `.changeset/config.json` exists: `access: public`, `baseBranch: main`,
  `changelog: @changesets/cli/changelog`, `commit: false`. (TODO Phase 0 done.)
- `@changesets/cli@2.31.0` is a root devDependency (`package.json`).
- All seven candidate packages are currently `"private": true` and version
  `0.0.1` (typescript-config is `0.0.0`):
  - `@hogsend/core`, `@hogsend/db`, `@hogsend/email`,
    `@hogsend/plugin-posthog`, `@hogsend/plugin-resend`, `@hogsend/engine` —
    **make publishable.**
  - `@repo/typescript-config` — already has `publishConfig.access=public` but is
    a build-time-only shared config. **Decision: keep private** (it is `@repo/*`,
    not `@hogsend/*`, and is a devDependency of packages — it must NOT be a
    runtime dep of any published package; see §3.6).
  - `apps/api` (`@hogsend/api`) and root `growthhog` — **keep private.**
- `create-hogsend` does **not exist yet** — it is built in Phase 3. This plan
  references it; if Phase 3 is incomplete when Phase 4 runs, treat the
  `create-hogsend` rows as "apply the same publishable-package checklist when it
  lands" and skip it in the dry-run.
- Packages export raw `.ts` (`"exports": { ".": "./src/index.ts" }`); only
  `email`, `plugin-posthog`, `plugin-resend` have a `tsup` `build` script today.
  `core`, `db`, `engine` have **no build step** (intentional — bundled by
  consumers).
- `@hogsend/db` loads migrations from `../drizzle` at runtime and inlines
  `../drizzle/meta/_journal.json` via JSON import (`version.ts:5`). The SQL files
  in `packages/db/drizzle/*.sql` are read from disk by `drizzle-orm`'s
  `migrate()` — they MUST be in the tarball.
- Docs disabled in prod: `packages/engine/src/app.ts:73`.
- No `.npmrc`. Existing git tags: `v0.1.0`, `v0.2.0` (app-level, predate this
  migration).
- CI today: `.github/workflows/ci.yml` (quality + test + migrations jobs). The
  release workflow is a **new file**, not an edit to ci.yml.

---

## 2. Step-by-step implementation

### Step 2.1 — Make the seven `@hogsend/*` packages publishable

For **each** of `core`, `db`, `email`, `plugin-posthog`, `plugin-resend`,
`engine` edit `packages/<name>/package.json`:

1. **Remove** `"private": true`.
2. **Add** `"publishConfig": { "access": "public" }` (explicit per-package even
   though `.changeset/config.json` sets `access: public` — npm reads
   `publishConfig`, changesets passes the access flag, belt-and-suspenders).
3. **Add** package metadata required for a clean public publish:
   - `"license": "MIT"` (match `@repo/typescript-config` which already declares MIT).
   - `"repository": { "type": "git", "url": "https://github.com/withseismic/hogsend.git", "directory": "packages/<name>" }`
     (confirm the canonical remote URL with `git remote get-url origin`; use that
     URL — do not invent one).
   - `"sideEffects": false` for the pure-library packages (`core`, `db`,
     `plugin-posthog`, `plugin-resend`). **Do NOT** set `sideEffects: false` on
     `engine` or `email` without checking — engine has module-init side effects
     (container/registry singletons, `registry-singleton.ts`) and email loads
     `.tsx`. Safer: omit `sideEffects` on `engine` and `email`.
4. **Add a `"files"` allowlist** so the tarball ships source (+ runtime assets):
   - `core`: `["src", "README.md"]`
   - `db`: `["src", "drizzle", "README.md"]` ← **`drizzle` is load-bearing** (SQL + `meta/_journal.json`).
   - `email`: `["src", "emails", "README.md"]` (it exports `./templates/*` → `./emails/*.tsx`; the `dist/` from its tsup build is optional — if kept, add `"dist"`, but since the export map points at `src`/`emails`, those are required).
   - `plugin-posthog`: `["src", "README.md"]`
   - `plugin-resend`: `["src", "README.md"]`
   - `engine`: `["src", "README.md"]`
   - Rationale: with `files`, npm always also includes `package.json`,
     `LICENSE*`, and the `README`. Everything else (tests, tsconfig, node_modules,
     `.turbo`) is excluded. Verify with `pnpm pack` in Step 2.6.
5. **`exports` / `main` / `types`** — keep the existing `exports` maps (they
   point at `./src/*.ts`). Add top-level `"main"` and `"types"` mirrors for
   tooling that ignores `exports`:
   - e.g. `core`: `"main": "./src/index.ts"`, `"types": "./src/index.ts"`.
   - `db`: `"main": "./src/index.ts"`, `"types": "./src/index.ts"`.
   - `engine`: `"main": "./src/index.ts"`, `"types": "./src/index.ts"` (its
     `exports` already has `.` and `./worker`).
   - `email`: `"main": "./src/index.ts"`, `"types": "./src/index.ts"`.
6. **Version** — leave all at `0.0.1` for now. Changesets will set the first real
   version. (Do NOT hand-bump.) Confirm against the migration plan: engine line
   versions move together via changesets `linked`/`fixed` — see Step 2.2.4.
7. **`README.md`** — each publishable package needs at least a stub `README.md`
   (npm shows a "no README" warning otherwise; not fatal but the `files`
   allowlist references it). Create a one-paragraph stub per package describing
   what it is and linking to the repo docs. (`core`, `db`, `engine` currently
   have none; check `email`/`plugin-*`.)

> **`workspace:` protocol note:** internal deps use `workspace:*` / `workspace:^`
> (e.g. engine depends on `@hogsend/core: workspace:^`). pnpm + changesets rewrite
> `workspace:^` to the concrete published range (`^1.4.0`) at publish time
> automatically. `workspace:*` rewrites to the exact version. **Recommendation:**
> normalize all internal `@hogsend/*` deps to `workspace:^` (not `*`) so consumers
> get a caret range — change `core`'s `@hogsend/db: workspace:*`, `core`'s and
> `plugin-resend`'s `@hogsend/email: workspace:*`, and `engine`'s
> `@hogsend/core: workspace:^` (already `^`). Do this with `pnpm` if possible, or
> edit the `workspace:*` → `workspace:^` strings directly (this is the protocol
> prefix, not a version range, so it is allowed to hand-edit).

### Step 2.2 — Changesets release workflow `.github/workflows/release.yml`

Create a **new** workflow (do not modify `ci.yml`). Use the official
`changesets/action@v1`.

Exact shape:

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false   # never cancel an in-flight publish

permissions:
  contents: write       # push tags + the version-bump PR/commit
  pull-requests: write  # open the "Version Packages" PR
  id-token: write       # npm provenance (OIDC) if enabled

env:
  NODE_VERSION: "22"

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
          registry-url: "https://registry.npmjs.org"
      - run: pnpm install --frozen-lockfile
      # Gate: the engine must build/type-check before we publish anything.
      - run: pnpm check-types
      - run: pnpm build
      - name: Create Release PR or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm release       # see Step 2.3 root script
          commit: "chore(release): version packages"
          title: "chore(release): version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Behavior (standard changesets two-phase flow):
- **Phase A** — merge to `main` with unreleased changesets present →
  `changesets/action` opens/updates a **"Version Packages" PR** that runs
  `pnpm changeset version` (bumps versions, writes CHANGELOGs, deletes consumed
  changeset files).
- **Phase B** — when that PR merges (no changesets left, versions already
  bumped) → the action runs `publish` → `pnpm release` publishes to npm and
  pushes tags.

Notes baked into the workflow file as comments:
- `NPM_TOKEN` is an **npm automation token** scoped to publish `@hogsend/*`
  (org-scoped) and `create-hogsend`. Add it under repo Settings → Secrets. **Do
  not** create or store a real token as part of this phase — document the
  requirement only.
- `id-token: write` + npm provenance is opt-in; if the org has not enabled
  provenance, drop `id-token` and the `--provenance` flag. Document both states.

### Step 2.3 — Root `package.json` release scripts

Add to root `package.json` `"scripts"` (use `pnpm add` only if a new dep is
needed — none is; `@changesets/cli` is already present):

- `"changeset": "changeset"`
- `"version-packages": "changeset version"`
- `"release": "pnpm build && changeset publish"`

`changeset publish` (a) publishes every package whose version is not yet on the
registry, (b) skips `private` packages automatically (so `apps/api`,
`growthhog`, `@repo/typescript-config` are never published), (c) creates and
pushes git tags `@hogsend/engine@1.4.0` etc. The leading `pnpm build` is a guard
so a broken build can't publish (relevant for `email`/`plugin-*` which do emit
`dist`; harmless for the source-shipping packages).

### Step 2.4 — Engine-line version coupling (semver discipline in config)

The migration plan requires the engine line to move together and migrations to
ship versioned with the package. Encode in `.changeset/config.json`:

- Add a **`linked`** group so the schema-coupled packages bump in lockstep when
  any of them gets a changeset *in the same release* (linked = share the highest
  bump that release, but only when changed together — looser than `fixed`):

  ```jsonc
  "linked": [["@hogsend/engine", "@hogsend/db", "@hogsend/core"]]
  ```

  Rationale: `@hogsend/engine`'s boot guard asserts the DB ledger matches the
  bundled migrations from `@hogsend/db` (`getBundledMigrations`), and `core`
  carries the shared types both consume. Tying their versions prevents a client
  ending up on engine `1.4` + db `1.2`. `email` and the two `plugin-*` packages
  stay independent (they don't carry migrations or the boot-guard contract).
- Keep `"updateInternalDependencies": "patch"` (already set) so a bump to a
  dependency package patch-bumps its dependents' recorded ranges.
- Document the `linked` choice and the alternative (`fixed`, which forces a bump
  even when unchanged) in `docs/RELEASING.md` so the trade-off is explicit.

### Step 2.5 — `docs/RELEASING.md` (semver + migration-versioning contract)

Create `docs/RELEASING.md` covering:

1. **What publishes and what doesn't** — the seven `@hogsend/*` + `create-hogsend`
   publish; `apps/*` and `@repo/typescript-config` stay private. Table.
2. **The two-phase changesets flow** — author adds a changeset (`pnpm changeset`),
   merge accumulates them, the "Version Packages" PR bumps + writes CHANGELOGs,
   merging that PR publishes.
3. **Semver discipline (the rules)**:
   - **major** = breaking change to the engine public API surface
     (`packages/engine/src/index.ts` exports / `createApp` / `createContainer` /
     `createWorker` / `defineJourney` / `defineWebhookSource` signatures) **OR**
     a non-expand/contract (destructive) schema migration. Cross-link
     `docs/engine-boundary.md` for the API surface and `docs/UPGRADING.md` §2 for
     expand→migrate→contract.
   - **minor** = additive API, new injection point, additive (expand) migration.
   - **patch** = bug fix, no API/schema change.
   - Every breaking changeset must flag `⚠️ breaking` and list required backfills
     in its CHANGELOG body (clients read this per `UPGRADING.md` step 2).
4. **Engine migrations ship versioned with the package** — `@hogsend/db@X.Y.Z`
   bundles exactly engine migrations `0000..N` (its `drizzle/` folder, shipped via
   the `files` allowlist). `@hogsend/engine` is `linked` to `@hogsend/db`, so a
   migration-bearing release bumps both. The boot guard
   (`apps/api/src/index.ts` → `getSchemaVersion` from `@hogsend/engine`) enforces
   the DB caught up. State plainly: **a new migration file = at minimum a minor
   bump of the engine line; a destructive migration = major.**
5. **`create-hogsend` pins the engine line** — its own version tracks the engine
   line and it emits `@hogsend/engine: ^X.Y` (cross-link Phase 3).
6. **The publish model decision** — packages ship raw `.ts`; consumers bundle via
   tsup `noExternal`; therefore `files` must include `src/` (+ `drizzle/`,
   `emails/`). Note this is why `pnpm pack` tarballs contain `.ts` not `.js`.
7. **Dry-run / never-publish-by-hand** — local verification is `pnpm pack` +
   `pnpm -r publish --dry-run --no-git-checks`; real publishing only happens in CI
   via the release workflow.

Add a one-line pointer at the top of `docs/UPGRADING.md` linking to
`docs/RELEASING.md` ("for how versions are cut and what a version *means*, see
RELEASING.md").

### Step 2.6 — Confirm `/docs` + `/openapi.json` disabled in production

No code change expected — `packages/engine/src/app.ts:73` already gates the
OpenAPI doc + Scalar `/docs` mount behind `container.env.NODE_ENV !== "production"`.
Phase 4 deliverable is a **regression test** locking this (Step 3, test T4) so a
future engine change can't silently expose docs in prod.

---

## 3. Test plan (DRY-RUN, additive, revert all version mutations)

> All version/publish testing must leave the repo's real versions unchanged. Use
> the **scratch-copy / git-revert** discipline in T2 and T3. Run from repo root
> unless noted.

### T0 — Baseline gate (must pass before and after)
- `pnpm check-types`
- `pnpm build`
- `pnpm lint`
- `pnpm --filter @hogsend/api test` (the 102-test suite + T4 below)

### T1 — `pnpm changeset` produces a changeset
- Run `pnpm changeset` non-interactively is awkward; instead **hand-author** a
  throwaway changeset file `.changeset/zz-phase4-dryrun.md`:
  ```md
  ---
  "@hogsend/engine": minor
  "@hogsend/db": minor
  ---

  Phase 4 dry-run changeset (DELETE before finishing).
  ```
- Assert: `pnpm changeset status --since=main` (or `pnpm changeset status`)
  reports the pending bumps for `@hogsend/engine` and `@hogsend/db`, and — via the
  `linked` group — `@hogsend/core` too. **This proves the `linked` config works.**

### T2 — `pnpm changeset version` yields sane bumps + changelogs (then REVERT)
- Ensure the working tree is clean except the throwaway changeset.
- Run `pnpm changeset version`.
- Assert:
  - `packages/engine/package.json`, `packages/db/package.json`,
    `packages/core/package.json` versions all moved to the same minor (e.g. all
    `0.1.0`) — the linked group bumped together.
  - `email`, `plugin-posthog`, `plugin-resend` versions **unchanged** (not in the
    changeset, not linked).
  - `CHANGELOG.md` files appear under `packages/engine`, `packages/db`,
    `packages/core` with the changeset body.
  - The throwaway `.changeset/zz-phase4-dryrun.md` was consumed (deleted).
- **REVERT everything:** `git checkout -- packages/*/package.json packages/*/CHANGELOG.md`
  and `git clean -f packages/*/CHANGELOG.md` (CHANGELOGs are new files), and
  delete any residual `.changeset/zz-phase4-dryrun.md`. Then re-run
  `git status --porcelain` and assert **no version/changelog diffs remain**. This
  satisfies "Keep the repo's real package versions unchanged at the end."

### T3 — Publish resolves with no error (dry-run, no real publish)
- With the `files`/`publishConfig`/`exports` edits from Step 2.1 in place (these
  are permanent, not reverted):
  - Per-package tarball inspection — `pnpm pack` each publishable package and
    inspect contents:
    ```
    pnpm --filter @hogsend/db pack --pack-destination /tmp/hogsend-pack
    tar -tzf /tmp/hogsend-pack/hogsend-db-0.0.1.tgz
    ```
    Assert the **db** tarball contains `package/drizzle/0000_*.sql` …
    `0007_serious_captain_universe.sql` and `package/drizzle/meta/_journal.json`
    and `package/src/migrate.ts` — i.e. the migrations travel. Assert it does NOT
    contain `node_modules`, `__tests__`, or `tsconfig.json`.
    Repeat for `engine` (assert `package/src/index.ts`, `package/src/app.ts`
    present), `core`, `email` (assert `package/emails/*.tsx`), and both plugins.
  - Whole-repo dry run — `pnpm -r publish --dry-run --no-git-checks`. Assert it
    resolves with exit 0 and the log lists exactly the seven `@hogsend/*` (+
    `create-hogsend` if Phase 3 done) as "would publish", and **excludes**
    `@hogsend/api`, `growthhog`, `@repo/typescript-config` (private → skipped).
  - Clean up `/tmp/hogsend-pack` and any `*.tgz` left in package dirs
    (`git status` must be clean of tarballs).

### T4 — Prod docs-disabled regression test (NEW permanent test)
- Add `apps/api/src/__tests__/openapi-prod.test.ts` (vitest, same pattern as the
  existing suite — calls `app.request()` directly, no HTTP server). Two cases:
  - **production** — build a container/app with `NODE_ENV=production` (set via the
    existing test-env seam — mirror how other tests construct the app/container in
    `apps/api/src/__tests__/health.test.ts`; override `env.NODE_ENV` through the
    container `overrides` seam or a test env var). Assert
    `app.request("/openapi.json")` → **404** and `app.request("/docs")` → **404**.
  - **non-production** — `NODE_ENV` ≠ `production` → assert `/openapi.json` → **200**
    with `content-type` JSON, and `/docs` → **200**.
- This is the codified proof for the TODO Verify line "Verify `/docs` +
  `/openapi.json` remain disabled in production builds." Add to the suite count
  (102 → 104).

> **Skipped from this phase's local testing (CI-only / requires real registry):**
> "Install published packages into a clean dir; `create-hogsend` resolves the
> pinned engine; app boots" (TODO line 207) and "Tag + CHANGELOG appear for a test
> release" (line 208). These require either a real publish or a local registry
> (Verdaccio). **Do not publish.** Document in `RELEASING.md` that the
> install-from-registry verification is exercised by Phase 3's tarball-based
> `pnpm dlx` test (Phase 3 Verify) and by the CI release workflow's first real run
> — out of scope for Phase 4's no-publish guardrail. (Optional: note Verdaccio as
> the local-registry option for whoever runs the real release, but do not stand it
> up here.)

---

## 4. Files touched (exact)

**Edited:**
- `packages/core/package.json` — drop `private`, add `publishConfig`/`files`/`main`/`types`/`license`/`repository`/`sideEffects`, normalize `workspace:^`.
- `packages/db/package.json` — same, **`files` must include `drizzle`**.
- `packages/email/package.json` — same, `files` includes `emails` (+ `dist` if kept).
- `packages/plugin-posthog/package.json` — same.
- `packages/plugin-resend/package.json` — same, normalize `@hogsend/email` `workspace:^`.
- `packages/engine/package.json` — same (no `sideEffects:false`).
- `.changeset/config.json` — add `linked` engine-line group.
- `package.json` (root) — add `changeset` / `version-packages` / `release` scripts.
- `docs/UPGRADING.md` — add top-of-file pointer to `RELEASING.md`.
- `create-hogsend/package.json` — apply the publishable checklist **iff** Phase 3 landed it.

**Created:**
- `.github/workflows/release.yml`
- `docs/RELEASING.md`
- `packages/{core,db,engine}/README.md` (and any missing in email/plugin-*).
- `apps/api/src/__tests__/openapi-prod.test.ts`

**Reverted after testing (must NOT remain changed):**
- `packages/*/package.json` version fields, `packages/*/CHANGELOG.md`,
  `.changeset/zz-phase4-dryrun.md`, any `*.tgz`.

---

## 5. Verification checklist (mirrors TODO Phase 4 Verify/Success)

- [ ] `pnpm changeset` (or hand-authored changeset) is recognized by
      `pnpm changeset status`, and the `linked` group pulls in `@hogsend/core`. (T1)
- [ ] `pnpm changeset version` on a scratch changeset produces correct, lockstep
      version bumps for the engine line and per-package CHANGELOGs — **then fully
      reverted; `git status --porcelain` shows no version/changelog diff.** (T2)
- [ ] `pnpm -r publish --dry-run --no-git-checks` resolves with exit 0; lists the
      seven `@hogsend/*` (+ `create-hogsend` if present), excludes the private
      packages. (T3)
- [ ] `pnpm pack` for each publishable package yields a tarball with built/runtime
      content: **`@hogsend/db` tarball includes `drizzle/*.sql` + `meta/_journal.json`**;
      `@hogsend/engine` includes `src/`; `email` includes `emails/`; none include
      `node_modules`/tests. (T3)
- [ ] `/docs` and `/openapi.json` return 404 when `NODE_ENV=production` and 200
      otherwise — locked by `openapi-prod.test.ts`. (T4)
- [ ] `docs/RELEASING.md` codifies: publish set, two-phase flow, semver rules
      (breaking API or destructive migration = major), and that engine migrations
      ship versioned with `@hogsend/db`/`@hogsend/engine` (boot-guard tie-in).
- [ ] `.github/workflows/release.yml` exists, is config-only (never run in this
      phase), uses `changesets/action@v1`, gates on `check-types`+`build`,
      publishes via `pnpm release`, and documents the `NPM_TOKEN`/provenance
      requirement.
- [ ] Baseline gate green throughout: `pnpm check-types`, `pnpm build`,
      `pnpm lint`, `pnpm --filter @hogsend/api test` (now 104). (T0)
- [ ] **Repo's real package versions are unchanged** vs the start of the phase
      (no version bump survives). **No `git push`. No real `npm publish`.**

---

## 6. Risks & sharp edges

- **db migrations must travel.** If `files` for `@hogsend/db` omits `drizzle/`,
  the published migrator throws at runtime (`existsSync(migrationsFolder)` →
  process.exit, `migrate.ts:15`) on every consumer. T3's tarball assertion is the
  guard. This is the single highest-risk item.
- **Raw-`.ts` publish surprises consumers** that don't bundle. Acceptable here
  because the migration plan locks the tsup `noExternal` model and `create-hogsend`
  scaffolds a consumer that bundles. Documented in RELEASING.md §6. If a future
  consumer needs prebuilt JS, that's a separate `exports`/`tsup` change.
- **`@repo/typescript-config` leaking as a runtime dep.** It is `devDependency`
  only in every package — confirm none of the seven list it under `dependencies`
  (they don't today) so the dry-run publish doesn't fail resolving an unpublished
  `@repo/*`. If any did, move it to `devDependencies`.
- **`workspace:*` vs `workspace:^`.** Left as `*`, published deps pin to an exact
  version (tighter than intended). Normalizing to `^` (Step 2.1.bullet) avoids
  over-pinning the engine line.
- **Forgetting to revert version bumps** after T2 dirties the repo and risks a
  real publish on the next CI run. The phase's exit criterion explicitly
  re-checks `git status`.
- **`changeset publish` needs git tags pushable** — the release workflow has
  `contents: write`; locally we never run `publish` (dry-run only), so no tag is
  created in this phase.
- **Provenance/OIDC** may fail if the org hasn't enabled it; the workflow
  documents both the with- and without-provenance form so the first real release
  isn't blocked.
