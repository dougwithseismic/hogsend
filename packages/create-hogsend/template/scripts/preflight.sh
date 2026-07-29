#!/usr/bin/env bash
#
# Preflight — the gate between "it builds" and "it deploys".
#
# Builds the production image the SAME way your platform does (this repo's
# Dockerfile), then BOOTS each run mode (api / worker / migrate) with a full,
# valid synthetic env so the app gets PAST env-validation into real startup —
# the logger, the DI container, worker init — which is where the interesting
# crashes live. It then asserts each mode:
#   (a) emits NO structural-failure marker (EACCES, mkdir, corepack, missing
#       module/binary, env-validation error), and
#   (b) reaches a known startup marker (server up / worker started).
#
# Before any of that it asserts PARITY: the command each mode boots must be the
# exact string the Railway config declares (`railway.toml` startCommand /
# preDeployCommand, `railway.worker.toml` startCommand). A gate that boots
# something other than what deploys is decorative, so drift is a hard failure.
#
# Infra (Postgres/Redis/Hatchet) is intentionally UNREACHABLE — each mode is
# expected to fail on *connect* AFTER booting cleanly. We assert HOW far it got,
# not that it talks to real services. This is the gate that catches the
# "builds fine, crash-loops on start" class that check-types + tests can't:
#   - tsup noExternal gap         -> ERR_MODULE_NOT_FOUND
#   - pnpm-based start command    -> corepack/deps-check -> EACCES on /app
#   - a devDependency needed at   -> "executable file not found" (pruned out of
#     runtime (e.g. tsx)             the production image)
#   - winston File transport      -> mkdir /app/logs -> EACCES (non-root)
#
# Run it before shipping anything that touches the runtime, build or deps:
#
#   pnpm preflight                            # build, then boot all three modes
#   pnpm preflight -- --image ghcr.io/me/app:sha --no-build
#   pnpm preflight -- --modes "api worker"
#   pnpm preflight -- --cmd migrate="tsx scripts/migrate.ts" \
#                     --marker api='listening on'
#
# Every input is also an env var (PREFLIGHT_IMAGE, PREFLIGHT_MODES,
# PREFLIGHT_CMD_<MODE>, PREFLIGHT_MARKER_<MODE>, PREFLIGHT_BAD,
# PREFLIGHT_TIMEOUT, PREFLIGHT_LOG_DIR, PREFLIGHT_ENV_<KEY>) so a CI job or a
# build pipeline can drive it without argv.
#
# Exits nonzero if ANY mode fails. Per-mode logs are kept and their paths
# printed, pass or fail.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

IMAGE="${PREFLIGHT_IMAGE:-hogsend-preflight:local}"
BUILD="${PREFLIGHT_BUILD:-1}"
DOCKERFILE="${PREFLIGHT_DOCKERFILE:-$ROOT/Dockerfile}"
CONTEXT="${PREFLIGHT_CONTEXT:-$ROOT}"
MODES="${PREFLIGHT_MODES:-api worker migrate}"
TIMEOUT="${PREFLIGHT_TIMEOUT:-12}"
LOG_DIR="${PREFLIGHT_LOG_DIR:-}"

# Substrings that mean a mode is STRUCTURALLY broken (vs an expected connect
# fail). Override wholesale with --bad / PREFLIGHT_BAD.
# `failed to run command` / `executable file not found` are how coreutils
# timeout and docker respectively report a missing binary — without them a mode
# with no startup marker (migrate) would PASS while never having run at all.
# NOTE: docker's "Unable to find image '<tag>' locally" is deliberately NOT a
# BAD marker — docker prints it to stderr before a SUCCESSFUL pull, so matching
# it would false-fail the `--no-build --image <remote-tag>` path on the first
# run and pass on the second. A genuinely missing image is caught up front by
# ensure_image() instead.
BAD="${PREFLIGHT_BAD:-EACCES|mkdir|corepack|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|Dynamic require of|command not found|failed to run command|executable file not found|permission denied|Invalid environment variables}"

# Extra `-e KEY=VALUE` pairs appended AFTER the synthetic defaults, so they win.
EXTRA_ENV=()

# --help prints the header block above, verbatim minus the comment markers, so
# the docs and the tool can never drift apart.
usage() {
  awk 'NR == 1 { next } !/^#/ { exit } { sub(/^#[[:space:]]?/, ""); print }' "$0"
  exit "${1:-0}"
}

die() { echo "✗ $*" >&2; exit 2; }

# bash 3.2 (macOS) has no associative arrays — per-mode settings live in
# dynamically named variables read back with indirect expansion.
mode_var() { # kind mode -> PREFLIGHT_CMD_MY_MODE
  local kind="$1" mode="$2"
  printf 'PREFLIGHT_%s_%s' "$kind" \
    "$(printf '%s' "$mode" | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
}

set_mode_var() { # kind mode value
  local var
  var="$(mode_var "$1" "$2")"
  eval "$var=\$3"
}

get_mode_var() { # kind mode -> value on stdout (empty when unset)
  local var
  var="$(mode_var "$1" "$2")"
  eval "printf '%s' \"\${$var-}\""
}

# `--cmd api="node dist/index.js"` and `--cmd api "node dist/index.js"` both work.
split_kv() { # "key=value" -> sets KV_KEY / KV_VALUE
  case "$1" in
    *=*) KV_KEY="${1%%=*}"; KV_VALUE="${1#*=}" ;;
    *) die "expected key=value, got '$1'" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a tag}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --dockerfile) DOCKERFILE="${2:?--dockerfile needs a path}"; shift 2 ;;
    --context) CONTEXT="${2:?--context needs a path}"; shift 2 ;;
    --modes) MODES="${2:?--modes needs a list}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    --log-dir) LOG_DIR="${2:?--log-dir needs a path}"; shift 2 ;;
    --bad) BAD="${2:?--bad needs a regex}"; shift 2 ;;
    --cmd) split_kv "${2:?--cmd needs mode=command}"; set_mode_var CMD "$KV_KEY" "$KV_VALUE"; shift 2 ;;
    --marker) split_kv "${2:?--marker needs mode=regex}"; set_mode_var MARKER "$KV_KEY" "$KV_VALUE"; shift 2 ;;
    --env) split_kv "${2:?--env needs KEY=VALUE}"; EXTRA_ENV+=(-e "$KV_KEY=$KV_VALUE"); shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker not found — preflight needs Docker"

# --- defaults for the three modes this image ships ------------------------
# A mode with no command (built-in or supplied) is a hard error, never a skip:
# silently skipping is how a gate becomes decorative.
default_cmd() {
  case "$1" in
    api) printf 'node dist/index.js' ;;
    worker) printf 'node dist/worker.js' ;;
    migrate) printf 'tsx scripts/migrate.ts' ;;
    *) printf '' ;;
  esac
}

# Startup markers. The engine logs these itself, so they hold for any app
# scaffolded from this template. Migrate is a one-shot with no "ready" line —
# it is asserted on the structural markers alone.
default_marker() {
  case "$1" in
    api) printf 'Hogsend API ready|Server running' ;;
    worker) printf 'Hogsend worker starting|worker started' ;;
    *) printf '' ;;
  esac
}

# --- synthetic env ---------------------------------------------------------
# Mirrors .env.example with valid-shaped placeholders. The HATCHET token is a
# public test JWT: it decodes (so HatchetClient.init succeeds) but is never used
# to authenticate against a real server. Infra hosts point at unreachable ports
# on purpose — see the header.
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
  -e RESEND_FROM_EMAIL='noreply@example.com'
  -e EMAIL_FROM='noreply@example.com'
  -e API_PUBLIC_URL='http://localhost:3002'
  -e ADMIN_API_KEY='test-admin-api-key'
  -e HOGSEND_ADMIN_KEY='test-admin-api-key'
  -e HATCHET_CLIENT_TLS_STRATEGY='none'
  -e HATCHET_CLIENT_HOST_PORT='127.0.0.1:7'
  -e HATCHET_CLIENT_TOKEN='eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test'
)

# PREFLIGHT_ENV_FOO=bar -> -e FOO=bar (the env-var form of --env).
while IFS='=' read -r name value; do
  [ -n "$name" ] || continue
  EXTRA_ENV+=(-e "${name#PREFLIGHT_ENV_}=$value")
done <<EOF
$(env | grep '^PREFLIGHT_ENV_' || true)
EOF

# --- railway parity --------------------------------------------------------
# The gate is only worth anything if it boots the SAME command strings the
# platform does. Read them back out of the Railway configs and refuse to run on
# a mismatch — that is the exact defect class that let `startCommand = "pnpm
# start"` ship next to an image where pnpm crash-loops.
#
# Only DEFAULT commands are checked: an explicit --cmd is the caller
# deliberately testing something else. Missing config files are skipped (not
# every deploy target is Railway).
railway_value() { # file key -> value on stdout
  [ -f "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*$/\1/p" "$1" | head -1
}

assert_railway_parity() {
  local drift=0 mode declared actual file key
  for mode in $MODES; do
    [ -z "$(get_mode_var CMD "$mode")" ] || continue
    case "$mode" in
      api) file="$ROOT/railway.toml"; key=startCommand ;;
      worker) file="$ROOT/railway.worker.toml"; key=startCommand ;;
      migrate) file="$ROOT/railway.toml"; key=preDeployCommand ;;
      *) continue ;;
    esac
    [ -f "$file" ] || continue
    declared="$(railway_value "$file" "$key")"
    [ -n "$declared" ] || continue
    actual="$(default_cmd "$mode")"
    if [ "$declared" != "$actual" ]; then
      echo "  ✗ $mode: $(basename "$file") $key = '$declared' but preflight boots '$actual'" >&2
      drift=1
    fi
  done
  [ "$drift" -eq 0 ] || die "deploy config drifted from preflight — the gate would not test what deploys"
  echo "▶ Railway configs and preflight run modes agree"
}

assert_railway_parity

# --- build -----------------------------------------------------------------
if [ "$BUILD" = "1" ]; then
  echo "▶ Building production image '$IMAGE' from $DOCKERFILE …"
  docker build -f "$DOCKERFILE" -t "$IMAGE" "$CONTEXT" \
    || die "docker build failed — your platform would fail the same way"
else
  echo "▶ Using prebuilt image '$IMAGE' (--no-build)"
  # Resolve the image ONCE, up front. Doing it here (rather than letting the
  # first `docker run` pull) keeps docker's "Unable to find image … locally"
  # progress chatter out of the per-mode logs, where it is indistinguishable
  # from a real failure — and turns a genuinely missing tag into one clear
  # error instead of N confusing ones.
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || docker pull "$IMAGE" \
    || die "cannot resolve image '$IMAGE' — not present locally and the pull failed"
fi

if [ -z "$LOG_DIR" ]; then
  LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hogsend-preflight.XXXXXX")"
else
  mkdir -p "$LOG_DIR" || die "cannot create log dir $LOG_DIR"
fi
echo "  logs: $LOG_DIR"

run_mode() { # mode
  local mode="$1" cmd good log
  cmd="$(get_mode_var CMD "$mode")"
  [ -n "$cmd" ] || cmd="$(default_cmd "$mode")"
  [ -n "$cmd" ] || die "no command for mode '$mode' — pass --cmd $mode='…'"

  good="$(get_mode_var MARKER "$mode")"
  [ -n "$good" ] || good="$(default_marker "$mode")"

  log="$LOG_DIR/$mode.log"
  echo "▶ Run mode '$mode': $cmd"

  # `timeout` runs INSIDE the container (the image is Debian-based, so it is
  # always present) — macOS ships no timeout(1), and a host-side guard would
  # leave the container running.
  # shellcheck disable=SC2086 # cmd is an intentional word-split command line.
  docker run --rm "${ENVS[@]}" "${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}" "$IMAGE" \
    timeout "$TIMEOUT" $cmd >"$log" 2>&1
  local out
  out="$(cat "$log")"

  if [ -z "$out" ]; then
    echo "  ✗ $mode: produced NO output in ${TIMEOUT}s — the mode never ran ($log)"
    return 1
  fi
  if printf '%s' "$out" | grep -qiE "$BAD"; then
    echo "  ✗ $mode: STRUCTURAL crash — would crash-loop in production ($log):"
    printf '%s\n' "$out" | grep -iE "$BAD" | head -3 | sed 's/^/      /'
    return 1
  fi
  if [ -n "$good" ] && ! printf '%s' "$out" | grep -qiE "$good"; then
    echo "  ✗ $mode: never reached startup marker /$good/ — did not boot ($log). Last lines:"
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
    return 1
  fi
  echo "  ✓ $mode: boots past init cleanly${good:+ (reached startup)} ($log)"
  return 0
}

fail=0
for mode in $MODES; do
  run_mode "$mode" || fail=1
done

echo ""
echo "  per-mode logs: $LOG_DIR"
if [ "$fail" -ne 0 ]; then
  echo "✗ PREFLIGHT FAILED — do not deploy. Fix the run mode(s) above."
  exit 1
fi
echo "✓ PREFLIGHT PASSED — image builds and every run mode boots past init."
