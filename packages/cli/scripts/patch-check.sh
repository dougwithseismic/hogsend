#!/usr/bin/env bash
# patch-check.sh — on-demand proof that `pnpm patch @hogsend/engine`:
#   1. re-applies on a clean install (committed .patch is honored), and
#   2. fails LOUDLY when an upstream change moves the patched lines.
#
# This is NOT wired into the always-on CI gate — it runs a real `pnpm install`
# and packs the local engine into a tarball (no registry needed). Run it
# manually from the repo root:
#
#   bash packages/cli/scripts/patch-check.sh
#
# It operates entirely in a throwaway temp dir; it never touches the dev DB,
# the repo working tree, or any remote.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENGINE_DIR="$REPO_ROOT/packages/engine"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hogsend-patch-check.XXXXXX")"
TARGET_FILE="src/routes/health.ts"           # a known engine source file
MARKER="HOGSEND_PATCH_PROOF_MARKER"

pass() { printf '\033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> work dir: $WORK"

# --- 1. Pack the local engine into a tarball (no registry). -----------------
echo "==> packing @hogsend/engine"
TARBALL="$(cd "$ENGINE_DIR" && pnpm pack --pack-destination "$WORK" | tail -1)"
# pnpm prints the tarball filename; resolve to an absolute path.
if [ ! -f "$TARBALL" ]; then
  TARBALL="$WORK/$(basename "$TARBALL")"
fi
[ -f "$TARBALL" ] || fail "could not locate packed tarball"
echo "    tarball: $TARBALL"

skip() { printf '\033[33mSKIP\033[0m %s\n' "$1"; exit 0; }

# --- 2. Init a tiny consumer that installs the tarball. ---------------------
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"
cat >"$CONSUMER/package.json" <<JSON
{
  "name": "patch-consumer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@hogsend/engine": "file:$TARBALL"
  }
}
JSON
set +e
INSTALL_OUT="$( cd "$CONSUMER" && pnpm install --ignore-scripts 2>&1 )"
INSTALL_CODE=$?
set -e
if [ "$INSTALL_CODE" -ne 0 ]; then
  # Before Phase 4 the engine's @hogsend/* deps are not on the registry, so a
  # standalone tarball install 404s. The patch CONTRACT is unchanged; it just
  # can't be exercised end-to-end until the packages publish. The binding eject
  # proof (the always-on unit suite) is unaffected.
  if echo "$INSTALL_OUT" | grep -qi "ERR_PNPM_FETCH_404\|not in the npm registry"; then
    echo "$INSTALL_OUT" | grep -i "404\|registry" | head -2
    skip "engine's @hogsend/* deps are not published yet (Phase 4). \
Run the manual patch steps in docs/customizing-the-engine.md §5 once published."
  fi
  echo "$INSTALL_OUT"
  fail "consumer install failed unexpectedly (exit=$INSTALL_CODE)"
fi
pass "consumer installs the packed engine"

# --- 3. Patch the engine and commit the patch. ------------------------------
# `pnpm patch` prints the temp edit dir as the last line.
EDIT_DIR="$( cd "$CONSUMER" && pnpm patch @hogsend/engine 2>/dev/null | tail -1 )"
[ -d "$EDIT_DIR" ] || fail "pnpm patch did not return an editable dir"
# Append a marker comment to a known file — line-local, easy to grep.
printf '\n// %s\n' "$MARKER" >>"$EDIT_DIR/$TARGET_FILE"
( cd "$CONSUMER" && pnpm patch-commit "$EDIT_DIR" >/dev/null )
ls "$CONSUMER/patches/"*.patch >/dev/null 2>&1 || fail "no .patch file written"
pass "patch committed (patches/ + pnpm.patchedDependencies)"

# --- 4. Assert re-apply on a clean install. ---------------------------------
( cd "$CONSUMER" && rm -rf node_modules && pnpm install --ignore-scripts >/dev/null )
if grep -rq "$MARKER" "$CONSUMER/node_modules/@hogsend/engine/$TARGET_FILE"; then
  pass "patch re-applies on a clean install"
else
  fail "patched marker missing after reinstall"
fi

# --- 5. Assert LOUD failure on an upstream conflict. ------------------------
# Repack the engine with the targeted file's content changed so the patch's
# context no longer matches, bump the version, and reinstall.
CONFLICT_SRC="$WORK/engine-conflict"
cp -R "$ENGINE_DIR" "$CONFLICT_SRC"
rm -rf "$CONFLICT_SRC/node_modules" "$CONFLICT_SRC/dist" "$CONFLICT_SRC/.turbo"
# Rewrite the whole targeted file so the patch hunk cannot apply.
printf '// upstream rewrite — patch context gone\nexport {};\n' \
  >"$CONFLICT_SRC/$TARGET_FILE"
node -e "const p=require('$CONFLICT_SRC/package.json');p.version='0.0.2';require('fs').writeFileSync('$CONFLICT_SRC/package.json',JSON.stringify(p,null,2))"
CONFLICT_TARBALL="$(cd "$CONFLICT_SRC" && pnpm pack --pack-destination "$WORK" | tail -1)"
[ -f "$CONFLICT_TARBALL" ] || CONFLICT_TARBALL="$WORK/$(basename "$CONFLICT_TARBALL")"

node -e "const p=require('$CONSUMER/package.json');p.dependencies['@hogsend/engine']='file:$CONFLICT_TARBALL';require('fs').writeFileSync('$CONSUMER/package.json',JSON.stringify(p,null,2))"

set +e
INSTALL_OUT="$( cd "$CONSUMER" && rm -rf node_modules && pnpm install --ignore-scripts 2>&1 )"
INSTALL_CODE=$?
set -e

if [ "$INSTALL_CODE" -ne 0 ] && \
   echo "$INSTALL_OUT" | grep -Eiq "could not apply patch|patch.*(fail|not apply|apply)"; then
  pass "install fails loudly when the patch no longer applies"
else
  echo "$INSTALL_OUT"
  fail "expected a loud patch-apply failure (exit=$INSTALL_CODE)"
fi

echo
pass "ALL PATCH CHECKS PASSED"
