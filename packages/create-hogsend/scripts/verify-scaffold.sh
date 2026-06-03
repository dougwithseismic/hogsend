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

PACKAGES=(core db email engine plugin-posthog plugin-resend)

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

# --- 1. build the CLI -----------------------------------------------------
echo "==> [1/8] build CLI"
pnpm --filter create-hogsend build >/dev/null
CLI="$PKG_DIR/dist/index.js"
[ -f "$CLI" ] || fail "CLI not built at $CLI"
head -1 "$CLI" | grep -q '#!/usr/bin/env node' || fail "missing shebang in $CLI"

# --- 2. pack @hogsend/* into a /tmp tarball dir ---------------------------
echo "==> [2/8] pack @hogsend/* tarballs"
TARBALLS="$(mktemp -d /tmp/hogsend-tarballs.XXXXXX)"
for pkg in "${PACKAGES[@]}"; do
  # `pnpm pack` works on private packages and (no `files` field) packs src/**.
  # Run with --dir on the package path: `--filter ... pack` is a recursive run,
  # which pnpm's `pack` rejects.
  pnpm --dir "$REPO_ROOT/packages/$pkg" pack \
    --pack-destination "$TARBALLS" >/dev/null
  tgz="$TARBALLS/hogsend-$pkg-0.0.1.tgz"
  [ -f "$tgz" ] || fail "tarball not produced: $tgz"
  tar -tzf "$tgz" | grep -q 'package/src/' || fail "$tgz missing package/src/**"
done
echo "    packed: $(ls "$TARBALLS" | tr '\n' ' ')"

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
  src/schema/index.ts scripts/migrate.ts
  drizzle.config.ts migrations/0000_init.sql migrations/meta/_journal.json
  migrations/meta/0000_snapshot.json
  docker-compose.yml railway.toml railway.worker.toml
  .env.example .node-version .gitignore
  biome.json vitest.config.ts tsconfig.json tsup.config.ts README.md
)
for f in "${EXPECTED[@]}"; do
  [ -e "$APPDIR/$f" ] || fail "missing scaffolded file: $f"
done

# token substitution + no residue
grep -q '"name": "my-app"' "$APPDIR/package.json" \
  || fail "APP_NAME token not applied in package.json"
grep -q 'file:.*hogsend-engine' "$APPDIR/package.json" \
  || fail "tarball file: dep not present in package.json"
if grep -rq '{{' "$APPDIR"; then
  fail "leftover {{ token in scaffold"
fi
if grep -q 'workspace:' "$APPDIR/package.json"; then
  fail "workspace: residue in package.json"
fi
echo "    filesystem + tokens OK"

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
