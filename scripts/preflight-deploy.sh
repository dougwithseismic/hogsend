#!/usr/bin/env bash
#
# Preflight deploy check.
#
# Builds the production image the SAME way Railway does (the repo Dockerfile),
# then BOOTS each run mode (api / worker / migrate) with a full, valid synthetic
# env so the app gets PAST env-validation into real startup — the logger, the DI
# container, worker init — which is where the interesting crashes live. It then
# asserts each mode:
#   (a) emits NO structural-failure marker (EACCES, mkdir, corepack, missing
#       module/binary, env-validation error), and
#   (b) reaches a known startup marker (server up / worker started).
#
# Infra (Postgres/Redis/Hatchet) is intentionally UNREACHABLE — each mode is
# expected to fail on *connect* AFTER booting cleanly. We assert HOW far it got,
# not that it talks to real services. This is the gate that catches the
# "builds fine, crash-loops on start" class that check-types + unit tests can't:
#   - tsup noExternal gap        -> ERR_MODULE_NOT_FOUND
#   - pnpm-based start command    -> corepack/deps-check -> EACCES on /app
#   - winston File transport      -> mkdir /app/logs -> EACCES (non-root)
#
# Run before pushing anything that touches the runtime, build, or deps:
#   pnpm preflight
#
set -uo pipefail

IMAGE="hogsend-preflight:local"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "✗ docker not found — preflight needs Docker"; exit 1; }

echo "▶ Building production image from Dockerfile (the builder Railway uses)…"
docker build -t "$IMAGE" . || { echo "✗ docker build failed — Railway would fail the same way"; exit 1; }

# Valid synthetic env (mirrors apps/api/vitest.config.ts). The HATCHET token is a
# public test JWT: it decodes (so HatchetClient.init succeeds) but is never used
# to authenticate against a real server. Infra hosts point at unreachable ports.
ENVS=(
  -e NODE_ENV=production
  -e PORT=3002
  -e LOG_LEVEL=info
  -e SKIP_SCHEMA_CHECK=true
  -e ENABLED_JOURNEYS='*'
  -e DATABASE_URL='postgresql://test:test@127.0.0.1:5/test'
  -e REDIS_URL='redis://127.0.0.1:6/0'
  -e BETTER_AUTH_SECRET='preflight-secret-minimum-32-characters-long-xx'
  -e BETTER_AUTH_URL='http://localhost:3002'
  -e RESEND_API_KEY='re_test_000000000000000000000000'
  -e RESEND_WEBHOOK_SECRET='whsec_test_secret_for_preflight'
  -e API_PUBLIC_URL='http://localhost:3002'
  -e ADMIN_API_KEY='test-admin-api-key'
  -e HATCHET_CLIENT_TLS_STRATEGY='none'
  -e HATCHET_CLIENT_HOST_PORT='127.0.0.1:7'
  -e HATCHET_CLIENT_TOKEN='eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test'
)

# Substrings that mean a mode is STRUCTURALLY broken (vs an expected connect fail).
BAD='EACCES|mkdir|corepack|Cannot find module|ERR_MODULE_NOT_FOUND|command not found|permission denied|Invalid environment variables'

run_mode() { # name  startup-marker-regex(optional)  cmd...
  local name="$1" good="$2"; shift 2
  echo "▶ Run mode '${name}': $*"
  local out
  out="$(docker run --rm "${ENVS[@]}" "$IMAGE" timeout 12 "$@" 2>&1 || true)"
  if printf '%s' "$out" | grep -qiE "$BAD"; then
    echo "  ✗ ${name}: STRUCTURAL crash — would crash-loop on Railway:"
    printf '%s\n' "$out" | grep -iE "$BAD" | head -3 | sed 's/^/      /'
    return 1
  fi
  if [ -n "$good" ] && ! printf '%s' "$out" | grep -qiE "$good"; then
    echo "  ✗ ${name}: never reached startup marker /${good}/ — did not boot. Last lines:"
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
    return 1
  fi
  echo "  ✓ ${name}: boots past init cleanly${good:+ (reached startup)}"
  return 0
}

fail=0
run_mode api     'Server running|Journey registry loaded'  node apps/api/dist/index.js     || fail=1
run_mode worker  'worker started|Journey registry loaded'  node apps/api/dist/worker.js    || fail=1
run_mode migrate ''                                         tsx packages/db/src/migrate.ts  || fail=1

echo ""
if [ "$fail" -ne 0 ]; then
  echo "✗ PREFLIGHT FAILED — do not deploy. Fix the run mode(s) above."
  exit 1
fi
echo "✓ PREFLIGHT PASSED — image builds and all three run modes boot past init."
