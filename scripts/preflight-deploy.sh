#!/usr/bin/env bash
#
# Preflight deploy check.
#
# Builds the production image the SAME way Railway does (the repo Dockerfile),
# then runs each run mode (api / worker / migrate) and asserts it STARTS CLEANLY:
# the command resolves and reaches application code, with no build-tool/runtime
# failure — EACCES, corepack download, missing module, or missing binary.
#
# This catches the "builds fine, crashes on start" class that check-types + unit
# tests miss, e.g.:
#   - a tsup `noExternal` gap  -> ERR_MODULE_NOT_FOUND at runtime
#   - a `pnpm`-based start cmd  -> corepack + deps-status check writes to the
#                                  read-only /app as the non-root user -> EACCES
#
# It does NOT need Postgres/Redis/Hatchet: each mode is EXPECTED to exit on
# missing infra/env. We assert HOW it fails (application-level), not that it
# fully boots. Run it before pushing anything that touches the runtime/build:
#
#   pnpm preflight
#
set -uo pipefail

IMAGE="hogsend-preflight:local"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found — preflight needs Docker to build the prod image"
  exit 1
fi

echo "▶ Building production image from Dockerfile (the builder Railway uses)…"
if ! docker build -t "$IMAGE" .; then
  echo "✗ docker build failed — Railway would fail the same way"
  exit 1
fi

# Output substrings that mean a run mode is STRUCTURALLY broken (vs just missing
# infra/env, which is fine — we only deny these).
BAD='EACCES|corepack|Cannot find module|ERR_MODULE_NOT_FOUND|command not found|permission denied'

check_mode() {
  local name="$1"
  shift
  echo "▶ Run mode '${name}': $*"
  # Override CMD with the real Railway command; cap runtime — it will exit on
  # missing env/DB, which is expected. Capture combined stdout+stderr.
  local out
  out="$(docker run --rm "$IMAGE" timeout 10 "$@" 2>&1 || true)"
  if printf '%s' "$out" | grep -qiE "$BAD"; then
    echo "  ✗ ${name}: structural failure — would crash-loop on Railway:"
    printf '%s\n' "$out" | grep -iE "$BAD" | head -3 | sed 's/^/      /'
    return 1
  fi
  echo "  ✓ ${name}: starts cleanly (reaches app code; no EACCES/corepack/missing-module)"
  return 0
}

fail=0
check_mode api     node apps/api/dist/index.js     || fail=1
check_mode worker  node apps/api/dist/worker.js    || fail=1
check_mode migrate tsx packages/db/src/migrate.ts  || fail=1

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✗ PREFLIGHT FAILED — do not deploy. Fix the run mode(s) above first."
  exit 1
fi
echo "✓ PREFLIGHT PASSED — all run modes start cleanly under the Dockerfile build."
