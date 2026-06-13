#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# discord-tunnel.sh — OPTIONAL convenience for the Discord local E2E.
#
# Starts a cloudflared quick tunnel to the local API (default port 3002), waits
# for the public URL, prints the three Discord Developer Portal URLs to paste,
# then keeps the tunnel in the foreground (Ctrl-C to stop). The runbook in
# docs/discord-e2e.md does NOT require this script — it just saves you copying
# the URL templates by hand. It writes NOTHING and needs NO Discord token.
#
# Usage:
#   scripts/discord-tunnel.sh           # tunnel to http://localhost:3002
#   PORT=3055 scripts/discord-tunnel.sh # tunnel to a different local port
#
# Requires: cloudflared (brew install cloudflared).
# -----------------------------------------------------------------------------
set -euo pipefail

PORT="${PORT:-3002}"
LOCAL_URL="http://localhost:${PORT}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "error: cloudflared not found. Install it: brew install cloudflared" >&2
  exit 1
fi

# A scratch log we tail to scrape the assigned public URL. cloudflared prints
# the trycloudflare URL to stderr, so capture both streams.
LOG="$(mktemp -t discord-tunnel.XXXXXX.log)"
cleanup() {
  [[ -n "${CF_PID:-}" ]] && kill "${CF_PID}" 2>/dev/null || true
  rm -f "${LOG}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting cloudflared quick tunnel to ${LOCAL_URL} ..."
# --config /dev/null is REQUIRED when ~/.cloudflared/config.yml exists, else the
# quick tunnel inherits that config's catch-all ingress and 404s everything.
# --protocol http2 is more stable than the default QUIC for trycloudflare.
cloudflared tunnel --config /dev/null --protocol http2 --url "${LOCAL_URL}" \
  >"${LOG}" 2>&1 &
CF_PID=$!

# Wait (up to ~30s) for the assigned https://<random>.trycloudflare.com URL.
TUNNEL_URL=""
for _ in $(seq 1 60); do
  TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG}" \
    | head -n1 || true)"
  [[ -n "${TUNNEL_URL}" ]] && break
  if ! kill -0 "${CF_PID}" 2>/dev/null; then
    echo "error: cloudflared exited early. Log:" >&2
    cat "${LOG}" >&2
    exit 1
  fi
  sleep 0.5
done

if [[ -z "${TUNNEL_URL}" ]]; then
  echo "error: timed out waiting for the tunnel URL. Log:" >&2
  cat "${LOG}" >&2
  exit 1
fi

cat <<EOF

================================================================================
Tunnel up:  ${TUNNEL_URL}  ->  ${LOCAL_URL}
================================================================================

1) Set in apps/api/.env (then (re)boot the API so it picks this up):

   API_PUBLIC_URL=${TUNNEL_URL}

2) Paste into the Discord Developer Portal
   (https://discord.com/developers/applications -> your app):

   OAuth2 tab        -> Redirects -> add:
     ${TUNNEL_URL}/v1/connectors/discord/oauth/callback

   General Info / app -> Interactions Endpoint URL  (Discord PINGs this on save,
   so the API must already be running on ${LOCAL_URL} behind this tunnel):
     ${TUNNEL_URL}/v1/connectors/discord/interactions

   Gateway worker ingress target (no portal entry — informational; the worker
   posts here automatically using CONNECTOR_INGRESS_SECRET):
     ${TUNNEL_URL}/v1/connectors/discord/ingress

Leave this running. Ctrl-C stops the tunnel.
================================================================================

EOF

# Hand the foreground back to cloudflared so its logs stream and Ctrl-C stops it.
wait "${CF_PID}"
