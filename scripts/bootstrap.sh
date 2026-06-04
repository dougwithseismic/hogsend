#!/usr/bin/env bash
set -euo pipefail

# Local dev bootstrap for the Hogsend monorepo (run via `pnpm bootstrap`).
#
# Idempotent + safe to re-run. It:
#   1. checks prerequisites (docker, pnpm, node, openssl) + the Docker daemon
#   2. creates apps/api/.env from the example with a fresh BETTER_AUTH_SECRET
#   3. auto-remaps any conflicting host ports so this stack coexists with others
#   4. brings up Timescale + Redis + Hatchet-Lite and waits for health
#   5. installs workspace dependencies
#
# Mirrors the create-hogsend scaffold's `bootstrap` step. NOTE: `pnpm setup` is a
# pnpm builtin (it shadows a "setup" script), which is why this is `bootstrap`.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

info()  { printf "\033[1;34m→\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m!\033[0m %s\n" "$1"; }
fail()  { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; exit 1; }

APP_ENV="apps/api/.env"
ROOT_ENV="$ROOT_DIR/.env"

# Cross-platform in-place sed (GNU needs `-i`; BSD/macOS needs `-i ''`).
sed_inplace() { # <expr> <file>
  if sed --version >/dev/null 2>&1; then sed -i -E "$1" "$2"; else sed -i '' -E "$1" "$2"; fi
}
upsert_env() { # <file> <key> <value>
  local file="$1" key="$2" val="$3"
  touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed_inplace "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}
remove_env_key() { # <file> <key>
  [ -f "$1" ] || return 0
  grep -q "^${2}=" "$1" 2>/dev/null || return 0
  sed_inplace "/^${2}=/d" "$1"
}
read_env() { # <file> <key> -> value on stdout (empty if absent)
  [ -f "$1" ] || return 0
  grep -E "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# --- Check prerequisites ---
for cmd in docker pnpm node openssl; do
  command -v "$cmd" &>/dev/null || fail "$cmd is not installed"
done

docker info &>/dev/null || fail "Docker daemon is not running"
ok "Prerequisites found (docker, pnpm, node, openssl)"

# --- Environment file ---
[ -f apps/api/.env.example ] || fail "apps/api/.env.example not found"
if [ ! -f "$APP_ENV" ]; then
  cp apps/api/.env.example "$APP_ENV"

  # Generate a real session-signing secret instead of shipping the placeholder.
  # The .env.example value is intentionally a non-secret placeholder; a fresh
  # self-hoster must never boot with a publicly-known BETTER_AUTH_SECRET.
  secret="$(openssl rand -base64 32)"
  # Escape characters that are special to sed's replacement (/, &, \).
  escaped_secret="$(printf '%s' "$secret" | sed -e 's/[\/&\\]/\\&/g')"
  if sed --version &>/dev/null; then
    # GNU sed
    sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${escaped_secret}/" "$APP_ENV"
  else
    # BSD/macOS sed
    sed -i '' "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${escaped_secret}/" "$APP_ENV"
  fi

  ok "Created apps/api/.env from .env.example (generated a fresh BETTER_AUTH_SECRET)"
else
  ok "apps/api/.env already exists"
fi

# --- Resolve host ports (auto-remap on conflict) ---
# `docker compose` runs from the repo root, so it interpolates ${*_PORT} from a
# ROOT .env (gitignored); the API process reads apps/api/.env. We keep both in
# sync. Using ${VAR:-default} in compose (not an override file) sidesteps the
# gotcha that Compose CONCATENATES `ports:` lists across files.
port_free() { # <port> -> 0 if free, 1 if in use
  # NOTE: probes IPv4 127.0.0.1 only. An IPv6-only listener (or a port reserved
  # by a stopped container from another project) can read as "free" and still
  # fail to bind — acceptable for a dev helper; `docker compose up` is the
  # ultimate arbiter.
  local p="$1"
  if command -v nc &>/dev/null; then
    nc -z -w1 127.0.0.1 "$p" &>/dev/null && return 1 || return 0
  fi
  # bash /dev/tcp fallback; subshell isolates the fd and keeps `set -e` happy.
  (exec 3<>"/dev/tcp/127.0.0.1/$p") &>/dev/null && return 1 || return 0
}
TAKEN=" "
PICKED=""
pick_port() { # <desired> -> sets $PICKED to first free port >= desired
  # MUST run in the current shell (never `$(pick_port ...)`) so the TAKEN dedup
  # set persists across calls; a subshell would discard it and two services
  # could be assigned the same host port. (bash 3.2: no associative arrays.)
  local p="$1"
  while :; do
    case "$TAKEN" in *" $p "*)
      p=$((p + 1))
      continue
      ;;
    esac
    if port_free "$p"; then break; fi
    p=$((p + 1))
  done
  TAKEN="${TAKEN}${p} "
  PICKED="$p"
}

PG=5434
RD=6380
DASH=8888
GRPC=7077
DID_REMAP=0
running="$(docker compose ps -q 2>/dev/null || true)"

if [ -n "$running" ]; then
  ok "Containers already running — keeping current ports"
  # Surface the persisted dashboard port (if a prior run remapped) for the hint.
  DASH="$(read_env "$ROOT_ENV" HATCHET_DASHBOARD_PORT)"
  DASH="${DASH:-8888}"
else
  pick_port 5434; PG="$PICKED"
  pick_port 6380; RD="$PICKED"
  pick_port 8888; DASH="$PICKED"
  pick_port 7077; GRPC="$PICKED"
  if [ "$PG" != 5434 ] || [ "$RD" != 6380 ] || [ "$DASH" != 8888 ] || [ "$GRPC" != 7077 ]; then
    DID_REMAP=1
  fi
fi

if [ "$DID_REMAP" = 1 ]; then
  warn "Host ports in use — remapped: pg ${PG}, redis ${RD}, dashboard ${DASH}, grpc ${GRPC}"
  upsert_env "$ROOT_ENV" POSTGRES_PORT "$PG"
  upsert_env "$ROOT_ENV" REDIS_PORT "$RD"
  upsert_env "$ROOT_ENV" HATCHET_DASHBOARD_PORT "$DASH"
  upsert_env "$ROOT_ENV" HATCHET_GRPC_PORT "$GRPC"
  sed_inplace "s|^(DATABASE_URL=[a-z]+://[^/]*:)[0-9]+|\\1${PG}|" "$APP_ENV"
  sed_inplace "s|^(REDIS_URL=[a-z]+://[^/]*:)[0-9]+|\\1${RD}|" "$APP_ENV"
  sed_inplace "s|^(HATCHET_CLIENT_HOST_PORT=[^:]*:)[0-9]+|\\1${GRPC}|" "$APP_ENV"
  ok "Synced remapped ports into ./.env (compose) and apps/api/.env (app)"
  warn "gRPC port changed — if you already minted a Hatchet token, re-mint it from the dashboard."
elif [ -z "$running" ] && [ -f "$ROOT_ENV" ] && grep -q "^POSTGRES_PORT=" "$ROOT_ENV" 2>/dev/null; then
  # Reclaim: a previous run remapped, but the default ports are free again.
  remove_env_key "$ROOT_ENV" POSTGRES_PORT
  remove_env_key "$ROOT_ENV" REDIS_PORT
  remove_env_key "$ROOT_ENV" HATCHET_DASHBOARD_PORT
  remove_env_key "$ROOT_ENV" HATCHET_GRPC_PORT
  if [ -f "$ROOT_ENV" ] && ! grep -q '[^[:space:]]' "$ROOT_ENV" 2>/dev/null; then
    rm -f "$ROOT_ENV"
  fi
  sed_inplace "s|^(DATABASE_URL=[a-z]+://[^/]*:)[0-9]+|\\15434|" "$APP_ENV"
  sed_inplace "s|^(REDIS_URL=[a-z]+://[^/]*:)[0-9]+|\\16380|" "$APP_ENV"
  sed_inplace "s|^(HATCHET_CLIENT_HOST_PORT=[^:]*:)[0-9]+|\\17077|" "$APP_ENV"
  ok "Default ports free again — reset to 5434/6380/8888/7077"
fi

# --- Start containers ---
info "Starting Docker containers (Timescale + Redis + Hatchet-Lite)..."
if [ -n "$running" ]; then
  docker compose up -d --wait --wait-timeout 120 || fail "Containers failed to become healthy within 120s"
else
  # Pass the chosen ports explicitly so the run is correct even before the root
  # .env write is read back (and on the all-defaults path it's a no-op).
  POSTGRES_PORT="$PG" REDIS_PORT="$RD" HATCHET_DASHBOARD_PORT="$DASH" HATCHET_GRPC_PORT="$GRPC" \
    docker compose up -d --wait --wait-timeout 120 || fail "Containers failed to become healthy within 120s"
fi
ok "Postgres, Redis and Hatchet-Lite are ready"

# --- Install dependencies ---
info "Installing dependencies..."
pnpm install

ok "Bootstrap complete."
printf "  Hatchet dashboard: http://localhost:%s  (admin@example.com / Admin123!!)\n" "$DASH"
# Guide the remaining steps a fresh checkout needs (token + migrations). These
# are intentionally not auto-run here — only the local infra is.
token="$(read_env "$APP_ENV" HATCHET_CLIENT_TOKEN)"
case "$token" in
*.*.*) : ;; # already a real JWT — nothing to do
*) warn "Set HATCHET_CLIENT_TOKEN in apps/api/.env — mint one from the dashboard above." ;;
esac
info "Next: cd packages/db && pnpm db:migrate   # then:   pnpm dev   (+ 'cd apps/api && hatchet worker dev')"
