#!/usr/bin/env bash
# eject-check.sh — on-demand sandbox proof for `hogsend eject`.
#
# The BINDING proof of the eject file operations is the always-on unit suite
# `packages/cli/src/__tests__/eject.test.ts` (run: pnpm --filter @hogsend/cli
# test). This script is the end-to-end sandbox: it builds the bin, fabricates a
# throwaway consumer, runs the REAL bin to eject @hogsend/engine, and asserts:
#   1. vendor/engine is populated from the engine source,
#   2. ONLY the engine dep is rewritten to file:./vendor/engine, and
#   3. every other @hogsend/* dep is left untouched (still upgradable).
#
# It points the bin at the in-repo engine source via --cwd-less resolution by
# pre-creating a node_modules symlink, so it needs NO registry and runs today.
# The further "builds from vendor/engine + pnpm up @hogsend/core still bumps"
# step needs the packages PUBLISHED (Phase 4); that part is documented in
# docs/customizing-the-engine.md §5 as manual steps and is intentionally not
# attempted here. Run from the repo root:
#
#   bash packages/cli/scripts/eject-check.sh
#
# Throwaway temp dir only; never touches the dev DB or any remote.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO_ROOT/packages/cli"
ENGINE_DIR="$REPO_ROOT/packages/engine"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hogsend-eject-check.XXXXXX")"

pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> work dir: $WORK"

# --- 1. Build the CLI bin so we can run `hogsend eject`. --------------------
( cd "$CLI_DIR" && pnpm build >/dev/null )
[ -f "$CLI_DIR/dist/bin.js" ] || fail "cli bin did not build"
pass "cli bin built"

# --- 2. Fabricate a consumer whose node_modules already has the engine. -----
# We symlink the engine source in directly (mimicking an installed workspace
# dep) so the bin's resolver finds it WITHOUT needing a registry/publish.
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER/node_modules/@hogsend"
ln -s "$ENGINE_DIR" "$CONSUMER/node_modules/@hogsend/engine"
cat >"$CONSUMER/package.json" <<JSON
{
  "name": "eject-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@hogsend/engine": "^0.0.1",
    "@hogsend/core": "^0.0.1"
  }
}
JSON
pass "consumer fabricated with engine resolvable from node_modules"

# --- 3. Eject the engine with the real bin. ---------------------------------
( cd "$CONSUMER" && node "$CLI_DIR/dist/bin.js" eject @hogsend/engine )
[ -f "$CONSUMER/vendor/engine/src/index.ts" ] || fail "vendor/engine not populated"
[ -d "$CONSUMER/vendor/engine/node_modules" ] && fail "node_modules should be excluded"
pass "engine source copied into vendor/engine (excludes honored)"

grep -q '"@hogsend/engine": "file:./vendor/engine"' "$CONSUMER/package.json" \
  || fail "engine dep not rewritten to file:./vendor/engine"
grep -q '"@hogsend/core": "\^0.0.1"' "$CONSUMER/package.json" \
  || fail "core dep should be left untouched (still upgradable)"
pass "only @hogsend/engine rewritten; @hogsend/core untouched (still pnpm up-able)"

# --- 4. Vendored package.json is sanitized. ---------------------------------
grep -q '"private": true' "$CONSUMER/vendor/engine/package.json" \
  && fail "vendored package.json should drop private:true"
grep -q '"name": "@hogsend/engine"' "$CONSUMER/vendor/engine/package.json" \
  || fail "vendored package.json should keep its name"
pass "vendored package.json sanitized (private dropped, name intact)"

echo
pass "ALL EJECT CHECKS PASSED"
echo
echo "NOTE: building the consumer FROM vendor/engine and proving"
echo "      'pnpm up @hogsend/core still bumps' needs the @hogsend/* packages"
echo "      PUBLISHED (Phase 4). Those manual steps are in"
echo "      docs/customizing-the-engine.md §5. Keep @hogsend/engine in the"
echo "      consumer's tsup noExternal after eject (the name is unchanged)."
