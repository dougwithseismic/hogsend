#!/usr/bin/env bash
# Headless (agent-driven) E2E: prove the ENTIRE zero-TTY path works —
# scaffold with flags → non-interactive bootstrap (Docker infra, migrations,
# keys) → build → background boot → health polls healthy → the env-preset
# admin actually signs in → the minted admin key drives the CLI.
#
# LOCAL-FIRST: needs Docker + several minutes of compose pulls on a cold
# machine. Wired to CI only as workflow_dispatch/nightly — never PR-gating.
#
#   bash packages/create-hogsend/scripts/verify-headless.sh
#
# Idempotent-ish: everything lives under a fresh mktemp dir; teardown (compose
# down -v + process kill) runs on ANY exit via trap.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

ADMIN_EMAIL="agent@example.com"
ADMIN_PASSWORD="hogsend-agent-pw"

TARBALLS=""
APP_PARENT=""
API_PID=""
APPDIR=""
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" >/dev/null 2>&1 || true
  if [ -n "$APPDIR" ] && [ -e "$APPDIR/docker-compose.yml" ]; then
    (cd "$APPDIR" && docker compose down -v >/dev/null 2>&1) || true
  fi
  [ -n "$TARBALLS" ] && rm -rf "$TARBALLS"
  [ -n "$APP_PARENT" ] && rm -rf "$APP_PARENT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  # Surface the boot log on failure — it usually names the culprit.
  [ -n "$APPDIR" ] && [ -f "$APPDIR/api-boot.log" ] && tail -30 "$APPDIR/api-boot.log" >&2
  exit 1
}

echo "==> [1/7] build CLI + pack tarballs"
pnpm --dir "$REPO_ROOT" --filter create-hogsend build >/dev/null
TARBALLS="$(mktemp -d /tmp/hogsend-headless-tarballs.XXXXXX)"
bash "$SCRIPT_DIR/pack-tarballs.sh" "$TARBALLS"

echo "==> [2/7] headless scaffold (all flags, no TTY)"
APP_PARENT="$(mktemp -d /tmp/hogsend-headless.XXXXXX)"
# The dir name doubles as the compose project name — mktemp keeps it unique,
# so this stack can't collide with a dev stack on the same machine.
APPNAME="hl-$(basename "$APP_PARENT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
APPDIR="$APP_PARENT/$APPNAME"
(cd "$APP_PARENT" && node "$PKG_DIR/dist/index.js" "$APPNAME" --pm pnpm \
  --no-git --posthog \
  --admin-email "$ADMIN_EMAIL" --admin-password "$ADMIN_PASSWORD" \
  --use-tarballs "$TARBALLS" </dev/null)
[ -e "$APPDIR/package.json" ] || fail "scaffold produced no app"
[ -d "$APPDIR/node_modules" ] || (cd "$APPDIR" && pnpm install >/dev/null 2>&1) \
  || fail "install failed"

echo "==> [3/7] non-TTY pnpm bootstrap (Docker infra + migrate + keys)"
(cd "$APPDIR" && pnpm bootstrap </dev/null) || fail "headless bootstrap exited non-zero"
ENV_FILE="$(cat "$APPDIR/.env")"
grep -q '^HOGSEND_API_KEY=hsk_' <<<"$ENV_FILE" || fail "no ingest key in .env"
grep -q '^HOGSEND_ADMIN_KEY=hsk_' <<<"$ENV_FILE" || fail "no admin key in .env"
grep -Eq '^HATCHET_CLIENT_TOKEN=[^.]+\.[^.]+\.[^.]+$' <<<"$ENV_FILE" \
  || fail "no 3-part Hatchet JWT in .env"
grep -q "^STUDIO_ADMIN_EMAIL=$ADMIN_EMAIL\$" <<<"$ENV_FILE" \
  || fail "STUDIO_ADMIN_EMAIL did not reach .env"

echo "==> [4/7] build + background boot"
(cd "$APPDIR" && pnpm build >/dev/null) || fail "build failed"
PORT="$(grep -m1 '^PORT=' <<<"$ENV_FILE" | cut -d= -f2)"
PORT="${PORT:-3002}"
(cd "$APPDIR" && node --env-file=.env dist/index.js >api-boot.log 2>&1) &
API_PID=$!

echo "==> [5/7] poll /v1/health until healthy"
HEALTHY=""
for _ in $(seq 1 60); do
  sleep 1
  # capture-then-grep (pipefail SIGPIPE gotcha)
  BODY="$(curl -s -m 2 "http://localhost:$PORT/v1/health" || true)"
  if grep -q '"status":"healthy"' <<<"$BODY"; then HEALTHY=1; break; fi
done
[ -n "$HEALTHY" ] || fail "API never reached status=healthy on :$PORT"
BOOT_LOG="$(cat "$APPDIR/api-boot.log")"
grep -q "Hogsend API ready" <<<"$BOOT_LOG" \
  || fail "structured ready line missing from boot log"
grep -qi "first admin created" <<<"$BOOT_LOG" \
  || fail "env-preset admin was not minted at first boot"

echo "==> [6/7] prove the admin password + the admin key"
SIGNIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
  -X POST "http://localhost:$PORT/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
[ "$SIGNIN_STATUS" = "200" ] \
  || fail "admin sign-in with the preset password returned $SIGNIN_STATUS"
(cd "$APPDIR" && node --env-file=.env node_modules/@hogsend/cli/dist/bin.js \
  stats --json >/dev/null) || fail "hogsend stats --json failed with the minted admin key"

echo "==> [7/7] teardown (trap)"
echo ""
echo "PASS: headless scaffold -> bootstrap -> boot -> health -> admin sign-in -> CLI all green."
