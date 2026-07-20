# Releasing Hogsend

How Hogsend versions are cut, what a version *number means*, and the rule that
**engine migrations ship versioned with the package**. This is the producer-side
contract; [UPGRADING.md](./UPGRADING.md) is the consumer-side one (how a client
applies a release safely). For the committed public API surface that governs
major bumps, see [engine-boundary.md](./engine-boundary.md).

> **Releases happen only in CI.** Locally you may *dry-run* (`pnpm pack`,
> `pnpm -r publish --dry-run`) but you must not publish from a feature branch or
> push a tag. The normal publish runs in `.github/workflows/release.yml`; the
> narrowly scoped recovery procedure for a failed first publish is in §8.

> **`release-doctor` enforces the integrity rules below.** `pnpm release-doctor`
> (the **Release integrity** CI job, and a gate at the top of `release.yml`)
> asserts the version-line invariants in this doc; `pnpm version-packages` runs
> `release-doctor --sync` to auto-bump `ENGINE_VERSION` (§5) into the Version PR;
> and `release.yml` runs `scripts/verify-published.mjs` after publish to confirm
> every package actually resolves on npm (§1/§8). The sections below remain the
> source of *why* — the doctor is the *enforcement*.

---

## 1. What publishes, and what stays private

| Package | Publishes? | Notes |
| --- | --- | --- |
| `@hogsend/core` | ✅ public | types, schemas, conditions, durations, registry |
| `@hogsend/db` | ✅ public | schema + **engine migrations** (`drizzle/`) + migrator |
| `@hogsend/email` | ✅ public | React Email templates (`emails/`) |
| `@hogsend/testing` | ✅ public | deterministic, zero-infrastructure journey test harness |
| `@hogsend/plugin-posthog` | ✅ public | PostHog integration |
| `@hogsend/plugin-resend` | ✅ public | Resend `EmailProvider` (delivery + webhook parse/verify) |
| `@hogsend/plugin-postmark` | ✅ public | Postmark `EmailProvider` (opt-in; on the engine line, **not** scaffold-pinned) |
| `@hogsend/engine` | ✅ public | the framework: `createApp`/`createHogsendClient`/`createWorker`/`defineJourney`/`defineWebhookSource` |
| `create-hogsend` | ✅ public | the `pnpm dlx` scaffolder |
| `@hogsend/api` (`apps/api`) | ❌ private | the in-repo dogfood consumer |
| `growthhog` (repo root) | ❌ private | the monorepo itself |
| `@repo/typescript-config` | ❌ private | build-time-only shared tsconfig; a **devDependency** of packages, never a runtime dep — it must never appear under any published package's `dependencies` |

`changeset publish` skips every package with `"private": true`, so the three
private workspaces above are never published even if they accumulate changesets.

Each publishable package declares `"publishConfig": { "access": "public" }` and a
`"files"` allowlist. The most load-bearing allowlist is **`@hogsend/db`**, whose
`files` includes `drizzle` — see §4.

---

## 2. The two-phase changesets flow

1. **Author a changeset** alongside the change:

   ```bash
   pnpm changeset        # pick packages + bump level, write a summary
   ```

   Commit the generated `.changeset/*.md` with the PR.

2. **Merge to `main`.** The release workflow's `changesets/action` sees the
   accumulated changesets and opens/updates a **"Version Packages" PR** that runs
   `pnpm changeset version` — it bumps versions, writes/updates each package's
   `CHANGELOG.md`, and deletes the consumed changeset files.

3. **Merge the "Version Packages" PR.** Now there are no changesets left and the
   versions are already bumped, so the action runs `publish` → `pnpm release`
   (`pnpm build && changeset publish`), which publishes the public packages to
   npm and pushes git tags (`@hogsend/engine@1.4.0`, …).

Nothing in this two-phase flow runs locally during normal development; you only
ever run `pnpm changeset` to author the intent.

### 2a. The Version Packages PR is a rolling accumulator — merge it LAST

The "Version Packages" PR (step 2) is **not** a snapshot. `changesets/action`
rebuilds it on every push to `main`, folding in each newly-merged changeset. So
the batching rule is:

> **Merge feature PRs first; merge the Version Packages PR last and
> deliberately — never while a feature PR you want in the release is still open
> or in CI.**

Merging the Version Packages PR is the explicit "cut the release now" action:
step 3 publishes immediately on that merge. If it merges while a feature PR is
mid-CI, that feature's changeset isn't folded in yet, so the release ships
**without** that work and it slips to the next version (a real occurrence:
`0.33.0` published while the `0.34.0` feature was still in CI, forcing an extra
release). Before merging it, run **`pnpm release:check`** — it prints the version
this release will publish, the changesets it includes, and any **open PR whose
changeset is not yet merged** (i.e. work that would be left out). Merge those
first if you mean to include them.

**Keep auto-merge OFF on the Version Packages PR.** An auto-merging version PR
publishes out from under in-flight work — the same failure, now unattended. That
merge must be a human decision.

---

## 3. Semver discipline

Decide the bump level by the **largest** of these that applies:

- **major** —
  - a breaking change to the engine public API surface
    (`packages/engine/src/index.ts`: `createApp`, `createHogsendClient`,
    `createWorker`, `defineJourney`, `defineWebhookSource`, and the types they
    export — see [engine-boundary.md](./engine-boundary.md)); **or**
  - a **destructive / non-expand-contract** schema migration (drop/rename a
    column or table, tighten a constraint over existing data) — anything that
    violates the expand→migrate→contract discipline in
    [UPGRADING.md §2](./UPGRADING.md).
- **minor** —
  - additive public API (a new injection point, a new optional option, a new
    export that doesn't change existing signatures); **or**
  - an **additive (expand)** migration (new nullable column, new table, new
    index) — a new migration file is **at minimum a minor** engine-line bump.
- **patch** — a bug fix with no API change and no new migration.

Every **breaking** changeset must flag `⚠️ breaking` in its summary and list any
**required backfills** in the body — clients read this from the `CHANGELOG` per
[UPGRADING.md](./UPGRADING.md) before upgrading.

### The engine line moves in lockstep

`.changeset/config.json` deliberately has no `linked` or `fixed` group:

```jsonc
"fixed": [],
"linked": []
```

Changesets' linked groups do not add untouched siblings to a release, and a new
member without release history can distort their version calculation. Instead,
`release-doctor` discovers every publishable `@hogsend/*` package plus the bare
`hogsend` alias from disk. If any member is in a pending changeset, the doctor
requires the entire discovered line to receive the same bump. Run
`pnpm release-doctor --fix-changeset` to create or refresh the uniform changeset;
do not maintain a hard-coded package count.

Why the line is uniform:

- `@hogsend/engine`'s boot guard (`apps/api/src/index.ts` →
  `getSchemaVersion` from `@hogsend/engine`) asserts the database ledger matches
  the migrations bundled in `@hogsend/db`. Shipping engine `1.4` against db `1.2`
  would let the guard and the schema drift apart.
- The public packages depend on and re-export one another. A single minor line
  keeps published ranges, generated apps, raw-source transforms, and shared
  types coherent.

`"updateInternalDependencies": "patch"` keeps each package's recorded internal
dependency range fresh when a dependency bumps. `create-hogsend` is not an
`@hogsend/*` member, but the doctor also requires it to move whenever the engine
line moves because its emitted dependency pins must remain installable.

---

## 4. Engine migrations ship versioned with the package

`@hogsend/db@X.Y.Z` bundles exactly engine migrations `0000..N` in its `drizzle/`
folder. That folder **travels in the published tarball** via the `files`
allowlist (`["src", "drizzle", "README.md"]`) because the migrator reads SQL from
disk at runtime:

- `packages/db/src/migrate.ts` resolves `new URL("../drizzle", import.meta.url)`
  and `existsSync`-guards it — if the folder is missing the migrator
  `process.exit`s, so **every consumer would crash at boot** if `drizzle/` were
  omitted from the tarball.
- `packages/db/src/version.ts` inlines `../drizzle/meta/_journal.json` to compute
  the required schema version count.

Consequences for releasing:

- **Adding a migration file ⇒ at minimum a minor bump of the engine line**
  (run `pnpm release-doctor --fix-changeset` after authoring the changeset).
- **A destructive migration ⇒ major.**
- The boot guard enforces that a deployed client actually applied the bundled
  migrations after `pnpm up` (`/v1/health` reports `schema.engine.inSync`).

Clients own their **own** migration track
(`drizzle.__client_migrations`) separately — engine releases never touch it. See
the two-track design.

---

## 5. `create-hogsend` pins the engine line

`create-hogsend` tracks the engine's major/minor line (it may sit one or more
patches ahead), and the app it scaffolds pins each package in
`HOGSEND_PACKAGES` to `^{{ENGINE_VERSION}}`. `ENGINE_VERSION` always equals the
engine package version and is synchronized by `pnpm version-packages`.
`@hogsend/testing` is a scaffold dev dependency; runtime packages remain normal
dependencies. Because internal `@hogsend/*` deps use the `workspace:^` protocol,
pnpm/Changesets rewrites them to caret ranges (`^1.4.0`) at publish time —
consumers never receive `workspace:` specifiers.

---

## 6. Publish model: raw `.ts`, bundled by the consumer

Most framework packages, including `@hogsend/core`, `@hogsend/db`,
`@hogsend/engine`, and `@hogsend/testing`, ship **raw TypeScript source**
(`exports`/`main`/`types` point at `./src/*.ts`). Consumers bundle them via tsup
`noExternal` or configure their test runner to transform the dependency. A few
front-door packages (`client`, `js`, `react`, `studio`, and parts of `cli`/`mcp`)
intentionally ship a built `dist/`; the scaffold verifier asserts those files.
That is why:

- `pnpm pack` tarballs contain `.ts`, not `.js`.
- `files` must include `src/` (and `drizzle/` for db, `emails/` for email) so the
  source actually travels.
- No new build step is required for raw-source packages to be publishable.

This is locked.
If a future consumer needs prebuilt JS, that's a separate change to `exports` +
`tsup`, out of scope for the current model.

---

## 6b. Vendored agent skills ship via `@hogsend/cli`

The Claude Code skills shipped into scaffolded apps live in **one source**,
`packages/cli/skills/`. `@hogsend/cli` ships it (`files[]`), and
`create-hogsend`'s `prebuild` (`scripts/sync-skills.mjs`) build-copies it into
`template/.claude/skills/` (a gitignored artifact that still rides the `template`
tarball entry; `hogsend skills add` / `hogsend upgrade` install from the same
source). Two consequences for releases:

- **`@hogsend/cli` rides the engine version line and is scaffold-pinned.** Keep
  it in `HOGSEND_PACKAGES`, both scaffold pack/verify lists, and the template
  dependencies. The vendored skill files also ride the `template` tarball as a
  build artifact, so both install paths are verified.
- **On any engine public-API change, content-audit `packages/cli/skills/*`** for
  staleness and bump `@hogsend/cli` so the refreshed skills publish. Keep
  `@hogsend/cli` published — the scaffolded-app refresh path
  (`pnpm dlx hogsend skills add --all --force`, `hogsend upgrade`) and the
  `hogsend doctor` staleness nudge resolve it from npm.

---

## 7. Local dry-run verification

Before relying on a release, verify locally **without publishing**:

```bash
# Inspect a tarball's contents (db MUST contain drizzle/*.sql + meta/_journal.json):
pnpm --filter @hogsend/db pack --pack-destination /tmp/hogsend-pack
tar -tzf /tmp/hogsend-pack/hogsend-db-0.0.1.tgz | grep drizzle

# Resolve the whole-repo publish without sending anything to the registry:
pnpm -r publish --dry-run --no-git-checks
```

The dry run lists every public `@hogsend/*` package (+ `create-hogsend`) as
"would publish" and excludes the private workspaces. **Clean up any `*.tgz` afterward** so
`git status` stays clean.

If you want to exercise an actual install-from-registry flow without touching the
public registry, stand up a local **Verdaccio** registry and publish to it — this
is the only supported way to test a real `pnpm dlx create-hogsend` against
published packages locally. Do not stand it up as part of routine work. After a
real release, follow the `release` skill's ordered registry, clean-install, and
released-scaffold checks; `verify-published.mjs` proves registry existence but
does not install the scaffold.

---

## 8. Publishing auth

**Today: a repo secret `NPM_TOKEN`** (an npm token with publish and package-create
rights in the `@hogsend` scope). `release.yml` mirrors it into
`NODE_AUTH_TOKEN` so `changeset publish` authenticates. The current token has
successfully created a new scoped package through this workflow; a new package
therefore follows the same two-phase CI release as every existing package.

New package names still need extra care. A Trusted Publisher cannot be
configured until the package exists, and some granular replacement tokens may
publish existing packages without being allowed to create another name. Before
merging a Version Packages PR that introduces a package, confirm that
`NPM_TOKEN` has not been replaced with a package-only token. After publish,
`scripts/verify-published.mjs` verifies every reported package/version directly
against the registry.

If the publish step or that verification fails for a new package, first use
`npm view` to prove the exact reported version is absent. Do not invent or
publish a different version and do not publish from the feature branch or
current `main`. Create a clean detached worktree at the failed release run's reviewed
Version Packages merge SHA, confirm the package manifest contains the exact
missing version, and confirm that exact version still returns 404 immediately
before publishing. Authenticate a maintainer with `@hogsend` create rights and
run `pnpm publish --access public --no-git-checks` from the new package
directory. Use **pnpm**, not raw `npm publish`, so `workspace:^` dependencies
are rewritten to real semver ranges.

Then verify the exact registry version, a clean external install, and that the
remote package tag exists at the reviewed release SHA. If the tag is absent or
points elsewhere, stop and investigate; do not create or push it manually.
Rerunning the failed job is useful for the audit trail, but after a manual
publish Changesets may report nothing new and skip its post-publish verifier,
so the explicit registry/install/tag checks are the recovery proof.

**Target: Trusted Publishing (OIDC), tokenless.** OIDC mints a short-lived,
workflow-scoped token at publish time (no stored secret) and attaches provenance
for free. `release.yml` already has `id-token: write` and upgrades npm to ≥ 11.5.1.
Migration is in progress across the public packages.

To finish the migration and drop the token:

1. Add a Trusted Publisher to each remaining public package (npmjs.com → package →
   Settings → Trusted Publisher → GitHub Actions).
2. Delete the `NPM_TOKEN` secret and remove the `NPM_TOKEN`/`NODE_AUTH_TOKEN` env
   lines from `release.yml`.

npm docs: <https://docs.npmjs.com/trusted-publishers/>
