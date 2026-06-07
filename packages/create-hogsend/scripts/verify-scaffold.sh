#!/usr/bin/env bash
# Phase 3 scaffold verification.
#
# Proves: build CLI -> pack @hogsend/* tarballs -> scaffold a fresh app in a
# clean /tmp dir (resolving @hogsend/* from those tarballs via file:) ->
# install -> check-types -> build -> biome check. Cleans up all /tmp dirs.
#
# No npm publish (tarballs only), no temp dirs in the repo, no DB mutation.
set -euo pipefail

# --- locate paths ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

PACKAGES=(cli client core db email engine plugin-posthog plugin-resend studio)

TARBALLS=""
APP_PARENT=""
cleanup() {
  [ -n "$TARBALLS" ] && rm -rf "$TARBALLS"
  [ -n "$APP_PARENT" ] && rm -rf "$APP_PARENT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Assert a tarball contains a path matching a pattern. CRITICAL: capture the
# `tar` listing into a variable FIRST, then `grep` the string. Piping
# `tar -tzf … | grep -q …` instead lets grep's first-match early-exit close the
# pipe, sending GNU tar a SIGPIPE (exit 141); under `set -o pipefail` that
# propagates as a pipeline failure and FALSELY trips the check. (BSD/macOS tar
# does not exit non-zero on SIGPIPE, so this only ever bit CI, never local.)
tar_has() {
  local listing
  listing="$(tar -tzf "$1")"
  grep -q "$2" <<<"$listing"
}

# --- 1. build the CLI -----------------------------------------------------
echo "==> [1/8] build CLI"
pnpm --filter create-hogsend build >/dev/null
CLI="$PKG_DIR/dist/index.js"
[ -f "$CLI" ] || fail "CLI not built at $CLI"
head -1 "$CLI" | grep -q '#!/usr/bin/env node' || fail "missing shebang in $CLI"

# --- 2. pack @hogsend/* into a /tmp tarball dir ---------------------------
echo "==> [2/8] pack @hogsend/* tarballs"
TARBALLS="$(mktemp -d /tmp/hogsend-tarballs.XXXXXX)"
# Some packages ship a built `dist` bundle and must be built before packing or
# their tarballs are empty:
#   - studio (files: ["dist"]) — the engine serves the Studio UI from it.
#   - cli + client — both ship dist/ and are now on the engine version line, so
#     the scaffold depends on them (^{{ENGINE_VERSION}}). client ships only
#     dist; cli ships dist + src. Build all three first. The remaining packages
#     ship raw `src/**` and need no build.
pnpm --filter @hogsend/studio build >/dev/null
pnpm --filter @hogsend/cli build >/dev/null
pnpm --filter @hogsend/client build >/dev/null
for pkg in "${PACKAGES[@]}"; do
  # `pnpm pack` works on private packages. Run with --dir on the package path:
  # `--filter ... pack` is a recursive run, which pnpm's `pack` rejects.
  pnpm --dir "$REPO_ROOT/packages/$pkg" pack \
    --pack-destination "$TARBALLS" >/dev/null
  # Version-agnostic: the tarball is named for the package's own version, so
  # match the glob rather than hardcoding a version that drifts each release.
  tgz="$(echo "$TARBALLS"/hogsend-"$pkg"-*.tgz)"
  [ -f "$tgz" ] || fail "tarball not produced for $pkg (no hogsend-$pkg-*.tgz)"
  case "$pkg" in
    studio | cli | client)
      # These ship a built dist/ — assert it travelled in the tarball.
      tar_has "$tgz" 'package/dist/' || fail "$tgz missing package/dist/**"
      ;;
    *)
      tar_has "$tgz" 'package/src/' || fail "$tgz missing package/src/**"
      ;;
  esac
done
echo "    packed: $(ls "$TARBALLS" | tr '\n' ' ')"

# create-hogsend's OWN publish-time pack must carry the generated .claude tree +
# the CLAUDE.template.md orientation file. The harness runs the CLI from dist/,
# so this `pnpm pack` is the ONLY check that exercises real publish-time packing
# of template/.claude (build step 1 ran the prebuild that populates it).
echo "==> [2b] assert create-hogsend pack carries template/.claude + CLAUDE.template.md"
pnpm --dir "$PKG_DIR" pack --pack-destination "$TARBALLS" >/dev/null
chtgz="$(echo "$TARBALLS"/create-hogsend-*.tgz)"
[ -f "$chtgz" ] || fail "create-hogsend tarball not produced"
tar_has "$chtgz" 'package/template/.claude/skills/.*/SKILL.md' \
  || fail "create-hogsend pack missing template/.claude/skills/**/SKILL.md"
tar_has "$chtgz" 'package/template/CLAUDE.template.md' \
  || fail "create-hogsend pack missing template/CLAUDE.template.md"

# --- 3. scaffold into a clean /tmp dir ------------------------------------
echo "==> [3/8] scaffold my-app"
APP_PARENT="$(mktemp -d /tmp/hogsend-app.XXXXXX)"
APPDIR="$APP_PARENT/my-app"
(cd "$APP_PARENT" && node "$CLI" my-app --pm pnpm --no-install --no-git \
  --use-tarballs "$TARBALLS")

EXPECTED=(
  package.json src/index.ts src/worker.ts
  src/journeys/index.ts src/journeys/welcome.ts src/journeys/test-onboarding.ts
  src/journeys/constants/index.ts
  src/buckets/index.ts src/buckets/power-users.ts
  src/webhook-sources/index.ts src/webhook-sources/posthog.ts
  src/workflows/index.ts src/workflows/backfill-example.ts
  src/schema/index.ts scripts/migrate.ts scripts/bootstrap.ts
  drizzle.config.ts migrations/0000_init.sql migrations/meta/_journal.json
  migrations/meta/0000_snapshot.json
  docker-compose.yml railway.toml railway.worker.toml
  .env.example .node-version .gitignore
  biome.json vitest.config.ts tsconfig.json tsup.config.ts README.md
  CLAUDE.md .claude/README.md .claude/skills/hogsend-cli/SKILL.md
)
for f in "${EXPECTED[@]}"; do
  [ -e "$APPDIR/$f" ] || fail "missing scaffolded file: $f"
done

# token substitution + no residue
grep -q '"name": "my-app"' "$APPDIR/package.json" \
  || fail "APP_NAME token not applied in package.json"
grep -q 'file:.*hogsend-engine' "$APPDIR/package.json" \
  || fail "tarball file: dep not present in package.json"
# Scope past the copied skill bodies (.claude/), which legitimately document
# {{ }} templating; CLAUDE.md sits at the app root and IS token-substituted, so
# it stays covered by the residue check.
if grep -rq '{{' "$APPDIR" --exclude-dir=.claude; then
  fail "leftover {{ token in scaffold"
fi
if grep -q 'workspace:' "$APPDIR/package.json"; then
  fail "workspace: residue in package.json"
fi
# CLAUDE.md is token-substituted with the app name.
grep -q '# my-app' "$APPDIR/CLAUDE.md" \
  || fail "APP_NAME token not applied in CLAUDE.md"
# Vendored skills must be byte-identical to the canonical source (drift gate).
diff -r "$APPDIR/.claude/skills" "$REPO_ROOT/packages/cli/skills" \
  || fail ".claude/skills drifted from packages/cli/skills"
echo "    filesystem + tokens OK"

# --- 3b. --no-skills omits .claude + CLAUDE.md ----------------------------
echo "==> [3b] scaffold (--no-skills) omits .claude + CLAUDE.md"
NOSKILLS_DIR="$APP_PARENT/no-skills"
(cd "$APP_PARENT" && node "$CLI" no-skills --pm pnpm --no-install --no-git \
  --no-skills --use-tarballs "$TARBALLS")
[ -e "$NOSKILLS_DIR/package.json" ] || fail "--no-skills produced no app"
[ ! -e "$NOSKILLS_DIR/.claude" ] || fail "--no-skills emitted .claude/"
[ ! -e "$NOSKILLS_DIR/CLAUDE.md" ] || fail "--no-skills emitted CLAUDE.md"
echo "    --no-skills OK"

# --- 4. install -----------------------------------------------------------
echo "==> [4/8] pnpm install (scaffolded app)"
(cd "$APPDIR" && pnpm install --ignore-workspace >/dev/null 2>&1) \
  || fail "pnpm install failed"
[ -f "$APPDIR/node_modules/@hogsend/engine/src/index.ts" ] \
  || fail "engine raw .ts not present in node_modules (tarball did not carry src)"

# --- 5. check-types -------------------------------------------------------
echo "==> [5/8] pnpm check-types (scaffolded app)"
(cd "$APPDIR" && pnpm check-types) || fail "check-types failed"

# --- 6. build -------------------------------------------------------------
echo "==> [6/8] pnpm build (scaffolded app)"
(cd "$APPDIR" && pnpm build >/dev/null) || fail "build failed"
[ -f "$APPDIR/dist/index.js" ] || fail "dist/index.js not produced"
[ -f "$APPDIR/dist/worker.js" ] || fail "dist/worker.js not produced"

# --- 7. lint --------------------------------------------------------------
echo "==> [7/8] biome check (scaffolded app)"
(cd "$APPDIR" && pnpm exec biome check .) || fail "biome check failed"

# --- 8. cleanup (trap) ----------------------------------------------------
echo "==> [8/8] cleanup /tmp dirs"
echo ""
echo "PASS: scaffold -> install -> check-types -> build -> lint all green."
