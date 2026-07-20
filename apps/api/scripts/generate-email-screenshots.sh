#!/usr/bin/env bash
# Regenerate the /emails gallery screenshots from the LIVE template registry —
# the docs PNGs can never drift from apps/api/src/emails again.
#
#   ./scripts/generate-email-screenshots.sh [key ...]
#
# No keys = every key in the registry. Renders with each template's registry
# `examples` via scripts/render-email-previews.tsx, then screenshots with
# headless Chrome into apps/docs/public/images/emails/ (slashes in keys become
# hyphens, matching the source-file naming convention).
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT_DIR="../docs/public/images/emails"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pnpm exec tsx scripts/render-email-previews.tsx "$TMP_DIR" "$@"

mkdir -p "$OUT_DIR"
for html in "$TMP_DIR"/*.html; do
  base="$(basename "$html" .html)"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=680,1250 \
    --screenshot="$OUT_DIR/$base.png" "file://$html" 2>/dev/null
  echo "shot $base.png"
done
