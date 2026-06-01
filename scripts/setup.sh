#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

info()  { printf "\033[1;34m→\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
fail()  { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; exit 1; }

# --- Check prerequisites ---
for cmd in docker pnpm node openssl; do
  command -v "$cmd" &>/dev/null || fail "$cmd is not installed"
done

docker info &>/dev/null || fail "Docker daemon is not running"
ok "Prerequisites found (docker, pnpm, node, openssl)"

# --- Environment file ---
[ -f apps/api/.env.example ] || fail "apps/api/.env.example not found"
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env

  # Generate a real session-signing secret instead of shipping the placeholder.
  # The .env.example value is intentionally a non-secret placeholder; a fresh
  # self-hoster must never boot with a publicly-known BETTER_AUTH_SECRET.
  secret="$(openssl rand -base64 32)"
  # Escape characters that are special to sed's replacement (/, &, \).
  escaped_secret="$(printf '%s' "$secret" | sed -e 's/[\/&\\]/\\&/g')"
  if sed --version &>/dev/null; then
    # GNU sed
    sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${escaped_secret}/" apps/api/.env
  else
    # BSD/macOS sed
    sed -i '' "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${escaped_secret}/" apps/api/.env
  fi

  ok "Created apps/api/.env from .env.example (generated a fresh BETTER_AUTH_SECRET)"
else
  ok "apps/api/.env already exists"
fi

# --- Start containers ---
info "Starting Docker containers (Postgres 18 + Redis)..."
docker compose up -d --wait --wait-timeout 60 || fail "Containers failed to become healthy within 60s"
ok "Postgres and Redis are ready"

# --- Install dependencies ---
info "Installing dependencies..."
pnpm install

ok "Setup complete — run 'pnpm dev' to start the API"
