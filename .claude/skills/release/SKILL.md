---
name: release
description: Cut a Hogsend npm release — the two-phase changesets flow, caret/version-line discipline, and the critical gotcha that CI CANNOT publish a brand-new @hogsend/* package (its first publish must be manual). Use when releasing or publishing @hogsend/* or create-hogsend, adding a new publishable package, bumping versions, reviewing a "Version Packages" PR, or debugging why a package didn't appear on npm despite a green release.
---

# Releasing Hogsend

Canonical reference: `docs/RELEASING.md`. This skill is the **operational runbook + the gotchas that doc doesn't cover yet**. Read the 🚨 section first if you are shipping a *new* package — it has caused a broken public release.

## 🤖 `release-doctor` enforces most of this now (added 2026-06-07)

Much of the discipline below is no longer manual — `scripts/release-doctor.mjs` makes it executable:

- **`pnpm release-doctor`** (the `--check` default) ASSERTS the version-line invariants: `ENGINE_VERSION` ↔ engine version, all engine-line packages on one version, the three scaffold lists agreeing (`HOGSEND_PACKAGES` ≡ `verify-scaffold.sh` PACKAGES ≡ template `@hogsend` deps), caret pins, no force-major peer trap, no migration-number collision, public/private publishConfig. It runs as the **Release integrity** CI job (every PR) and at the top of `release.yml`.
- **`pnpm version-packages`** = `changeset version && release-doctor --sync` — so the Version PR now **auto-bumps `ENGINE_VERSION`** to match the freshly-bumped engine. The old manual "hand-edit ENGINE_VERSION on the version PR branch" step is GONE.
- **`release.yml` post-publish** runs `scripts/verify-published.mjs` — GETs every just-published `name@version` from the registry and **fails loudly if any 404s** (the new-package gotcha).
- **`verify-scaffold.sh`** runs in the **Release integrity** CI job (path-gated to packaging changes) AND as the manual `pnpm --filter create-hogsend verify` — it builds + packs the real tarballs and scaffolds a fresh app, asserting the built `dist/` travels in each tarball. 🚨 **Heisenbug fixed 2026-06-07:** the tarball checks were `tar -tzf "$tgz" | grep -q 'package/dist/'` under `set -o pipefail` — `grep -q`'s first-match early-exit SIGPIPEs `tar`; GNU tar (Linux/CI) exits non-zero on SIGPIPE so `pipefail` FALSELY failed the check ("missing package/dist/**"), while BSD tar (macOS) doesn't, so it never reproduced locally. Fixed with a `tar_has()` helper that captures the listing first then greps a here-string. Lesson: in `pipefail` scripts, NEVER `bigcmd | grep -q` — capture then grep.

The runbook below is still the source of *why*; the doctor is the *enforcement*. If you add a new engine-line package, update `HOGSEND_PACKAGES` + `verify-scaffold.sh` PACKAGES + the template deps (the doctor's 3-way check fails until they agree) — the doctor derives its engine-line set from `HOGSEND_PACKAGES`, so there's no fourth list.

## The flow (two-phase changesets)

1. Make your code/doc changes.
2. `pnpm changeset` (or hand-write `.changeset/*.md`) declaring bump types per package. `pnpm changeset status` previews the result — **always run it** and read the cascade (see "Version-line discipline").
3. Commit, open a PR, get CI green (`ci.yml`: Lint & types, Tests, Migration safety, Deploy preflight), merge to `main`.
4. **Phase A** — `release.yml` runs on the merge and opens a **"Version Packages"** PR (`changeset version`: bumps versions, writes CHANGELOGs, deletes consumed changesets).
5. **Review that Version PR.** Confirm every package lands on the version you expect and that all *scaffold-pinned* packages stay on one compatible minor line (`grep '"version"'` the diff). The version bump is permanent once published.
6. Merge the Version PR → **Phase B** — `release.yml` runs `pnpm release` (`pnpm build && changeset publish`), publishing public packages + pushing git tags. Merging to `main` also deploys the docs to Railway.

`changeset publish` auto-skips private packages (`@hogsend/api`, `growthhog` root, `@repo/typescript-config`).

## 🚨 New-package gotcha (this broke a release — read before shipping a new @hogsend/* package)

**The CI publish token can publish new *versions* of existing packages but typically CANNOT *create* a brand-new package name** — granular npm tokens are scoped to packages that already exist.

What it looks like when it fails — and why it's dangerous:
- `changeset publish` prints `🦋 success ... @hogsend/<new>@X.Y.Z` and pushes a git tag. **CI stays green. The package is NOT on npm** (registry returns 404). changesets misreports the failure.
- If `create-hogsend` published in the same run and the scaffold depends on `@hogsend/<new>`, the **public scaffold is now broken** — `npx create-hogsend` → `pnpm install` 404s on the missing package.

**The fix — the first publish of any new `@hogsend/*` package must be MANUAL:**
```bash
npm login                                   # a maintainer account with @hogsend publish rights
npm whoami                                  # confirm you're authed
cd packages/<new-package>
pnpm --filter @hogsend/<new-package> build  # if it ships a built dist (e.g. studio) — ensure dist is fresh
npm publish --access public
```
A 404 on the `PUT` = not authed / not authorized to create in the `@hogsend` scope. A 403 "cannot publish over previously published versions" = it's already there (success). After it exists once, future versions publish via CI normally. You **cannot** pre-set an OIDC Trusted Publisher on a package that doesn't exist yet, so the first publish can't be tokenless either — do it manually, then add the Trusted Publisher (npmjs.com → package → Settings).

🚨 **`@hogsend/plugin-postmark` is exactly such a brand-new package — its FIRST publish MUST be MANUAL.** It's a new `@hogsend/*` name (the opt-in Postmark `EmailProvider`), so the CI publish token cannot CREATE it. Publish it by hand once, on the engine version line:
```bash
npm login                                            # maintainer with @hogsend create rights
npm whoami
pnpm --filter @hogsend/plugin-postmark build
cd packages/plugin-postmark && npm publish --access public
```
Then verify it on the registry (`curl -s https://registry.npmjs.org/@hogsend%2fplugin-postmark | head -c 300`) BEFORE relying on CI for it, and add an OIDC Trusted Publisher. After it exists once, future versions publish via CI on the engine line like everything else. It is opt-in and NOT scaffold-pinned, so a missing first publish does NOT break `npx create-hogsend` (unlike `@hogsend/client`) — but a consumer doing `pnpm add @hogsend/plugin-postmark` will 404 until the manual publish lands.

## Verify — CI green ≠ published

Never trust a green release for a new package. Always:
```bash
# 1. Direct registry GET (authoritative; bypasses npm CLI cache). "Not found" = not published.
curl -s https://registry.npmjs.org/@hogsend%2f<pkg> | head -c 300

# 2. End-to-end: a fresh scaffold must resolve every @hogsend dep from the registry.
cd /tmp && rm -rf hs-verify
npx -y create-hogsend@<version> hs-verify --pm pnpm --no-git --no-install
pnpm -C /tmp/hs-verify install            # expect exit 0
ls /tmp/hs-verify/node_modules/@hogsend/  # all scaffold-pinned packages present
# studio specifically ships a built SPA — confirm its dist travelled:
ls /tmp/hs-verify/node_modules/@hogsend/studio/dist/index.html
rm -rf /tmp/hs-verify
```
`docs/RELEASING.md §7` also has `pnpm -r publish --dry-run --no-git-checks` for a no-registry resolution check. Note: §7 claims "CI's first real run is the canonical end-to-end check" — that is **false for new packages** (the gotcha above); do the scaffold-install check yourself.

## Version-line discipline (why the scaffold pins caret)

- The scaffold template `packages/create-hogsend/template/_package.json` pins **`^{{ENGINE_VERSION}}`** (caret), consistent with `RELEASING.md §5`. `ENGINE_VERSION` and the `HOGSEND_PACKAGES` list both live in `packages/create-hogsend/src/template-manifest.ts` — keep `ENGINE_VERSION` equal to `@hogsend/engine`'s version, and **add any new scaffold-pinned package to `HOGSEND_PACKAGES`**.
- **Why caret, not exact:** bumping a package that `@hogsend/engine` depends on (`email`, `plugin-posthog`, `plugin-resend`) cascades engine to a *patch* (e.g. `0.1.0 → 0.1.1`) via `updateInternalDependencies: "patch"`, and drags its `linked` siblings (`db`, `core`). An exact pin can't equal both `0.1.0` and `0.1.1` and the scaffold breaks. A caret (`^0.1.0`) absorbs same-minor drift, so all deps just need to land on the same minor line.
- Changeset *bump types* (patch/minor) cannot align two packages that start on different version lines (e.g. `0.0.1` vs `0.1.0`) onto one number — caret pinning is what makes the single `ENGINE_VERSION` token work across the drift.

### 🚨 The `linked` group is DISBANDED (`linked: []`) — declare every engine-line package explicitly (2026-06-07 learnings)

The changeset `linked` group used to be `[engine, db, core, cli, client]`, but it caused TWO broken releases and was removed:
1. **`linked` does NOT auto-bump siblings.** Bumping only `engine` in a linked group leaves `db/core/cli/client` un-bumped — `linked` merely forces *already-bumped* members to share one number. So you must list every engine-line package in the changeset anyway.
2. **A brand-new member (no release history) corrupts the linked math** — it jumped `engine` to `1.0.0` on a `minor` changeset.

**The discipline now:** each release, write a changeset that EXPLICITLY bumps all ten engine-line packages (`engine, db, core, cli, client, email, plugin-posthog, plugin-resend, plugin-postmark, studio`) to the same bump type. They all start uniform, so they land uniform. `verify-scaffold.sh` catches drift in the nine *scaffold-pinned* packages, and `release-doctor`'s "all engine-line packages share one version" check — which derives its set from disk (every publishable `@hogsend/*` package) — catches drift across all ten, including opt-in `plugin-postmark`.

🚨 **`@hogsend/plugin-postmark` is on the engine line but is NOT scaffold-pinned.** It's the opt-in Postmark `EmailProvider` (Resend stays the scaffold default), so it is deliberately absent from `HOGSEND_PACKAGES`, `verify-scaffold.sh`'s `PACKAGES`, and `template/_package.json` deps — the doctor's 3-way scaffold check (`HOGSEND_PACKAGES ≡ verify-scaffold ≡ template deps`) must keep all three at the **nine** scaffold packages; do NOT add plugin-postmark to those lists or every scaffolded app would install the Postmark SDK by default. BUT it still rides the engine version line (matching engine) and MUST be bumped to the same line in every release changeset. `release-doctor`'s "all engine-line packages share one version" check now derives its set FROM DISK (every publishable `@hogsend/*` package, not `HOGSEND_PACKAGES`), so plugin-postmark **is** covered — drift off the line fails the doctor automatically. You still must add it to your changeset to actually *bump* it (the doctor enforces uniformity, not the bump itself). (Same shape — and same automatic coverage — applies to a future `@hogsend/plugin-ses`.)

🚨 **Peer-dependency = forced MAJOR bump.** changesets force-bumps a package to **major** whenever one of its `peerDependencies` is bumped. `@hogsend/client` peer-depended on `@hogsend/email` (bumped every release) → it computed `1.0.0` every time. Fixed by moving `@hogsend/email` to `client`'s `devDependencies` only (it's an optional, type-only peer; every consumer has it via `@hogsend/engine`). **Do NOT re-add `@hogsend/email` (or any frequently-bumped `@hogsend/*`) to `peerDependencies`.**

**Always sanity-check with a throwaway `pnpm changeset version` (then `git reset --hard`)** — `changeset status` bump-type labels lie for these cases; only the computed numbers tell the truth.

## `@hogsend/cli` + `@hogsend/client` — ON the engine line, scaffold dependencies

Both `@hogsend/cli` and `@hogsend/client` are now **on the engine version line** (shipped at `0.7.0`). They're listed in `HOGSEND_PACKAGES` and pinned by the scaffold as `^{{ENGINE_VERSION}}`. They must be bumped to the engine version every release — but via EXPLICIT changeset entries, NOT the `linked` group (which is disbanded — see the gotcha above).

- **The scaffold DEPENDS on `@hogsend/cli` and `@hogsend/client`.** Keep them in `template/_package.json` deps (`^{{ENGINE_VERSION}}`) and in `HOGSEND_PACKAGES` (`template-manifest.ts`). The verification harness (`packages/create-hogsend/scripts/verify-scaffold.sh`) packs both — they're in its `PACKAGES=(...)` array — and **builds them before packing** (`pnpm --filter @hogsend/cli build`, `pnpm --filter @hogsend/client build`) because both ship `dist/` (client ships only `dist`; cli ships `dist` + `src`). With cli on `0.6.0` the produced tarball is `hogsend-cli-0.6.0.tgz`, matching `copy.ts`'s `rewriteTarballDeps` (`hogsend-<name>-${ENGINE_VERSION}.tgz`).
- 🚨 **`@hogsend/client`'s FIRST npm publish must be MANUAL.** It's a brand-new `@hogsend/*` package, so the CI publish token cannot CREATE it (see the New-package gotcha above). Publish it by hand once — `cd packages/client && pnpm --filter @hogsend/client build && npm publish --access public` — and verify it on the registry **before** `create-hogsend` ships with the `^{{ENGINE_VERSION}}` pin that depends on it. Otherwise a public scaffold install 404s. After it exists once, future versions publish via CI on the engine line.

### Vendored agent skills (packages/cli/skills) — content-audited

The Claude Code skills shipped to scaffolded apps have a **single source**: `packages/cli/skills/`. `@hogsend/cli` ships that dir in its tarball (`files[]`), and `create-hogsend`'s `scripts/sync-skills.mjs` build-copies it into `template/.claude/skills/` (gitignored build artifact; rides the `template` tarball entry). `hogsend skills add` / `hogsend upgrade` install/refresh from the same source.

- **On an engine public-API change, content-audit `packages/cli/skills/*`** for staleness (imports, option names, ctx primitives, factory wiring). Since cli is now on the engine line, it bumps with the linked group automatically — the audit is a *content review* step to keep the shipped skills accurate.
- **Keep `@hogsend/cli` published.** A scaffolded app's later-fetch + refresh path (`pnpm dlx hogsend skills add --all --force`, `hogsend upgrade`) and the `hogsend doctor` staleness nudge all resolve `@hogsend/cli` from npm. It IS now a scaffold dependency too, but those refresh paths still resolve it from the registry — if it ever falls off, they silently break.

## Adding a new publishable package — checklist

1. `package.json`: `private: false`, `version` on the right line, `files`, `publishConfig.access: public`. Most packages ship **raw `.ts`** (`RELEASING.md §6`); **`@hogsend/studio` is the exception** — it ships a built `dist/` (`files: ["dist"]`, built by `vite build`), and the engine mounts `/studio` by resolving `@hogsend/studio/package.json` then `./dist`, so the tarball MUST contain `dist/index.html` + assets.
2. **If it's on the engine version line** (almost everything `@hogsend/*` is — e.g. `@hogsend/plugin-postmark`): set its `version` to the current engine version and add an explicit changeset entry bumping it with the rest of the engine line each release. Being on the line does NOT make it scaffold-pinned.
3. **If the scaffold depends on it** (i.e. it's a default the scaffolded app needs): add to `template/_package.json` deps as `^{{ENGINE_VERSION}}` **and** to `HOGSEND_PACKAGES` in `template-manifest.ts` **and** `verify-scaffold.sh`'s `PACKAGES` (the doctor's 3-way check requires all three agree). Opt-in providers like `@hogsend/plugin-postmark` are NOT scaffold deps — leave them OUT of all three lists.
4. Add a `create-hogsend` changeset so the template republishes with the new dep (only when step 3 applied).
5. **Do the first publish manually** (🚨 section — `@hogsend/plugin-postmark` is a current pending example), then verify on the registry + via a scaffold install (for scaffold deps) or a direct `pnpm add` (for opt-in packages), then add an OIDC Trusted Publisher for it.

## Auth

Publish auth is configured in `release.yml` + `docs/RELEASING.md §8`. The skill-relevant point: a new package's first publish needs a maintainer with **create** rights in the scope (granular token auth usually can't create a package), and tokenless OIDC Trusted Publishing can only be configured for a package *after* it exists — so it can't cover the first publish.

> Public repo: keep maintainer identities, account names, 2FA methods, and "which packages are token-only vs OIDC" out of this file. Those operational specifics live in the project's private memory, not here.
