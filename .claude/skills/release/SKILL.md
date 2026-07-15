---
name: release
description: Use when releasing or publishing @hogsend/* or create-hogsend, adding a publishable package or scaffold dependency, bumping versions, reviewing a "Version Packages" PR, or diagnosing a package that is missing from npm.
---

# Releasing Hogsend

Canonical reference: `docs/RELEASING.md`. This skill is the operational checklist for applying that policy. Normal releases, including the first publish of a new package, run in CI. Never publish from a feature branch and never invent a replacement version for a failed release.

## Executable release gates

- `pnpm release-doctor` checks `ENGINE_VERSION`, the disk-derived engine line, pending changeset coverage, scaffold dependency lists and caret pins, peer-dependency traps, raw-source runtime types, migration numbers, and publish visibility. It runs in the **Release integrity** PR job and before release.
- `pnpm release-doctor --fix-changeset` writes or refreshes `.changeset/engine-line-uniform.md` after a changeset touches any engine-line package. Use it instead of maintaining a hard-coded package count.
- `pnpm version-packages` runs `changeset version` and `release-doctor --sync`, so the Version Packages PR receives the matching `ENGINE_VERSION` automatically.
- `pnpm --filter create-hogsend verify` builds and packs the actual local packages, checks publish-time tarball surfaces, tests a clean consumer, generates fresh scaffolds, and installs/type-checks/tests/builds them without publishing.
- After `changeset publish`, `scripts/verify-published.mjs` resolves every reported `name@version` directly from npm. A missing package fails the release job.

## Two-phase release flow

1. Make the feature and documentation changes.
2. Add the intended `.changeset/*.md`, run `pnpm release-doctor --fix-changeset` when the engine line is touched, then run `pnpm changeset status` and `pnpm release-doctor`.
3. Open the feature PR, make all required checks green, and merge it to `main`.
4. The release workflow opens or updates the rolling **Version Packages** PR.
5. Merge every feature intended for the release first. Run `pnpm release:check`, review the Version Packages diff, and confirm the new versions, changelogs, `ENGINE_VERSION`, and scaffold pins.
6. Merge the Version Packages PR deliberately. That merge runs `pnpm release` and publishes packages/tags. Keep auto-merge off for this PR.
7. Confirm the release job's registry verification, then perform the clean external-install checks below.

`changeset publish` skips private workspaces. Do not publish locally during the normal flow and do not push release tags by hand.

## New package first publish: CI is the normal path

The current `NPM_TOKEN` can create new scoped package names. GitHub release run `29253259806` used the token whose secret metadata has been unchanged since 2026-06-01 to create `@hogsend/attribution@0.44.0` on 2026-07-13; the post-publish verifier then resolved it from npm. This is direct evidence against the old blanket claim that CI cannot create a new `@hogsend/*` package.

`@hogsend/plugin-postmark` and `@hogsend/client` are already published packages, so they have no pending first-publish action. Do not preserve package-specific warnings after the registry entry exists.

For a new name:

1. Use the normal feature PR -> Version Packages PR -> CI publish flow.
2. Before merging the Version Packages PR, inspect the `NPM_TOKEN` secret metadata. If it has been replaced since the known successful run, confirm the replacement retains package-create rights in the `@hogsend` scope.
3. Let `scripts/verify-published.mjs` verify the exact versions reported by Changesets. Do not treat Changesets' success text alone as proof.
4. Verify the new package in a clean directory before testing anything that depends on it.
5. If it is scaffold-pinned, verify the released scaffold only after all of its `@hogsend/*` dependencies resolve. This order distinguishes a missing package from a scaffold problem.

## Safe manual recovery after a verified CI publish failure

Manual publication is a recovery path only when the release job attempted the reviewed version and a direct registry check proves that exact `name@version` is missing. This applies whether the publish step failed explicitly or the post-publish verifier caught the absence.

1. Record the missing package and version from the failed release output, then confirm that exact version is absent with `npm view <name>@<version>`.
2. Create a clean detached worktree at the failed run's `headSha`. It must be the reviewed Version Packages merge commit containing that exact version, not a feature branch and not a later `main`.
3. Confirm `packages/<package>/package.json` still contains the missing version.
4. Authenticate a maintainer with `@hogsend` create rights, install the reviewed lockfile, build the package if it ships generated `dist/`, and publish from that package directory with **pnpm**:

   ```bash
   package_name="@hogsend/<package>"
   package_dir="packages/<package>"
   missing_version="<missing-version>"
   recovery="$(mktemp -d)/checkout"
   git worktree add --detach "$recovery" <reviewed-version-packages-commit>
   cd "$recovery"
   pnpm install --frozen-lockfile
   test "$(node -p "require('./$package_dir/package.json').version")" = "$missing_version"
   pnpm --filter "$package_name" build # only when the package ships dist/
   if npm view "$package_name@$missing_version" version >/dev/null 2>&1; then exit 1; fi
   pnpm --dir "$package_dir" publish --access public --no-git-checks
   ```

5. Verify the exact registry entry and a clean external install, then rerun the failed release job. Existing versions are skipped and the rerun may report no newly published packages, which also skips `verify-published.mjs`; retain the independent registry/install evidence.
6. Verify the expected tag points to the reviewed release commit with `git ls-remote --tags origin "refs/tags/@hogsend/<package>@<missing-version>"`. If it is absent or points elsewhere, stop and investigate the release workflow. Do not create or push a tag by hand.

Never bump to a new version as a workaround, publish the repository's current/later version, or push a tag manually. Use `pnpm publish`, never raw `npm publish`: pnpm rewrites `workspace:^` dependencies to registry semver ranges while raw npm can publish the workspace protocol verbatim.

## Post-publish verification order

```bash
# Keep these distinct: create-hogsend may be a patch ahead of the engine line.
package_version="<package-version>"
scaffolder_version="<create-hogsend-version>"

# 1. The exact package/version must exist.
npm view @hogsend/<new-package>@"$package_version" name version --json

# 2. Its tarball must install by itself outside the monorepo.
tmp="$(mktemp -d)"
printf '{"private":true}\n' >"$tmp/package.json"
pnpm --dir "$tmp" add @hogsend/<new-package>@"$package_version"

# 3. Only for a scaffold dependency: generate the released scaffold, then install it.
npx -y create-hogsend@"$scaffolder_version" "$tmp/app" --pm pnpm --no-git --no-install
node -e 'const p=require(process.argv[1]); if (!p.devDependencies?.["@hogsend/<new-package>"]) process.exit(1)' "$tmp/app/package.json"
pnpm --dir "$tmp/app" install
pnpm --dir "$tmp/app" check-types
pnpm --dir "$tmp/app" test
pnpm --dir "$tmp/app" build
rm -rf "$tmp"
```

For a package that ships built artifacts, also inspect the installed/tarball surface (for example, `@hogsend/studio/dist/index.html`). A registry GET proves existence; the clean install proves dependency metadata is consumable.

## Engine line and scaffold dependency rules

- `.changeset/config.json` has `linked: []`. Every publishable `@hogsend/*` package plus the bare `hogsend` alias is discovered from disk and rides one engine version. If a changeset touches one member, run `pnpm release-doctor --fix-changeset` so all members and `create-hogsend` receive the required bump.
- Do not write or maintain a fixed package count in release guidance. Adding a public package automatically extends the disk-derived engine line.
- `create-hogsend` stays on the engine's major/minor line and may be a patch ahead, never behind. `pnpm version-packages` syncs the emitted `ENGINE_VERSION` to the newly versioned engine.
- The scaffold uses `^{{ENGINE_VERSION}}`. Caret pins tolerate patch movement within the release line while keeping generated apps compatible.
- `HOGSEND_PACKAGES` is only the subset the generated app installs, not the full engine line. Optional packages such as `@hogsend/plugin-postmark` stay out. Current defaults such as `@hogsend/cli`, `@hogsend/client`, and the test-only `@hogsend/testing` stay in because the template depends on them.
- Never add an `@hogsend/*` package to another publishable package's `peerDependencies`; Changesets can force an unintended major bump. Use the repository's established runtime/dev dependency pattern instead.

### Adding a scaffold dependency

Treat runtime and development dependencies the same for list parity. Make these changes together, before merging the feature PR:

1. Add `@hogsend/<name>: ^{{ENGINE_VERSION}}` to the appropriate `dependencies` or `devDependencies` section in `packages/create-hogsend/template/_package.json`.
2. Add the short name to `HOGSEND_PACKAGES` in `packages/create-hogsend/src/template-manifest.ts`.
3. Add it to `PACKAGES` in both `packages/create-hogsend/scripts/verify-scaffold.sh` and `packages/create-hogsend/scripts/pack-tarballs.sh`. If it ships `dist/`, add its build and tarball-surface assertion too.
4. Add changesets for the new package and `create-hogsend` so both the package and public template release together; then run `pnpm release-doctor --fix-changeset`.
5. Extend the clean packed-consumer check when the new package needs proof that its own runtime/type dependencies work without the scaffold supplying them.
6. Run `pnpm release-doctor` and `pnpm --filter create-hogsend verify`.

The doctor checks the manifest list, verifier list, and both template dependency sections as one set. The full scaffold verifier then catches packing, rewrite, install, type, test, and build failures.

## Package checklist

1. Set `private: false`, the current engine-line version, an intentional `files` allowlist, and `publishConfig.access: public`.
2. Ship `src/` for raw-TypeScript packages. Build and include `dist/` only for packages whose exports require it. Put consumer-required runtime types in published dependencies, not only devDependencies.
3. Add the package changeset, then run `pnpm release-doctor --fix-changeset` and `pnpm release-doctor`.
4. If the scaffold imports it, complete the scaffold sequence above; otherwise keep it out of the scaffold lists.
5. Use the normal CI first publish, verify the exact registry version and clean install, and only use manual recovery after an actual verified failure.

## Vendored agent skills

`packages/cli/skills/` is the source for the Claude Code skills in scaffolded apps. `@hogsend/cli` publishes that directory, and `create-hogsend` copies it into the template at build time. On an engine public-API change, content-audit those skills for stale imports, options, and context methods. The CLI is bumped explicitly through the uniform engine-line changeset, not a linked group.

## Auth

`release.yml` mirrors the repository's `NPM_TOKEN` into `NODE_AUTH_TOKEN`. The token currently has demonstrated package-create rights; if its metadata changes, revalidate that capability before introducing a new name. Trusted Publishing remains the tokenless target, but it can only be configured after a package exists.

> Public repo: keep maintainer identities, account names, 2FA methods, and package-by-package auth details out of this file.
