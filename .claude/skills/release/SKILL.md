---
name: release
description: Cut a Hogsend npm release — the two-phase changesets flow, caret/version-line discipline, and the critical gotcha that CI CANNOT publish a brand-new @hogsend/* package (its first publish must be manual). Use when releasing or publishing @hogsend/* or create-hogsend, adding a new publishable package, bumping versions, reviewing a "Version Packages" PR, or debugging why a package didn't appear on npm despite a green release.
---

# Releasing Hogsend

Canonical reference: `docs/RELEASING.md`. This skill is the **operational runbook + the gotchas that doc doesn't cover yet**. Read the 🚨 section first if you are shipping a *new* package — it has caused a broken public release.

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
- Changeset *bump types* (patch/minor) cannot align two packages that start on different version lines (e.g. `0.0.1` vs `0.1.0`) onto one number — caret pinning is what makes the single `ENGINE_VERSION` token work across the drift. The `linked` group is `[engine, db, core]`.

## Adding a new publishable package — checklist

1. `package.json`: `private: false`, `version` on the right line, `files`, `publishConfig.access: public`. Most packages ship **raw `.ts`** (`RELEASING.md §6`); **`@hogsend/studio` is the exception** — it ships a built `dist/` (`files: ["dist"]`, built by `vite build`), and the engine mounts `/studio` by resolving `@hogsend/studio/package.json` then `./dist`, so the tarball MUST contain `dist/index.html` + assets.
2. If the scaffold depends on it: add to `template/_package.json` deps as `^{{ENGINE_VERSION}}` **and** to `HOGSEND_PACKAGES` in `template-manifest.ts`.
3. Add a `create-hogsend` changeset so the template republishes with the new dep.
4. **Do the first publish manually** (🚨 section), then verify on the registry + via a scaffold install, then add an OIDC Trusted Publisher for it.

## Auth

Publish auth is configured in `release.yml` + `docs/RELEASING.md §8`. The skill-relevant point: a new package's first publish needs a maintainer with **create** rights in the scope (granular token auth usually can't create a package), and tokenless OIDC Trusted Publishing can only be configured for a package *after* it exists — so it can't cover the first publish.

> Public repo: keep maintainer identities, account names, 2FA methods, and "which packages are token-only vs OIDC" out of this file. Those operational specifics live in the project's private memory, not here.
