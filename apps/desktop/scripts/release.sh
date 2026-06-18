#!/usr/bin/env bash
#
# Local release for the Hogsend desktop companion. Build on your Mac, push live
# — no CI runner. Produces a signed universal (Intel + Apple Silicon) bundle,
# publishes it to a versioned GitHub Release, and updates the stable updater
# manifest so installed apps self-update.
#
# Usage:
#   pnpm --filter @hogsend/desktop release          # build + publish
#   pnpm --filter @hogsend/desktop release --dry-run # build only, no publish
#
# Prereqs (one-time):
#   - gh CLI authed (`gh auth status`)
#   - updater key at ~/.tauri/hogsend-updater.key  (generated via `tauri signer generate`)
#     or export TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH yourself.
#
# Versioning: bump the version in src-tauri/tauri.conf.json (and package.json /
# Cargo.toml to match), then run this. The tag is desktop-v<version>.

set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Stable tag that only ever holds latest.json — the updater endpoint points
# here, so it must not collide with the per-package npm release tags.
MANIFEST_TAG="desktop-latest"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="desktop-v${VERSION}"

echo "▸ Hogsend desktop ${VERSION} (tag ${TAG})"

# --- preflight ------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  command -v gh >/dev/null || { echo "✗ gh CLI not found"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "✗ gh not authenticated (run: gh auth login)"; exit 1; }
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/hogsend-updater.key}"
  [ -f "$KEY_FILE" ] || {
    echo "✗ No updater signing key. Generate one with:"
    echo "    pnpm --filter @hogsend/desktop exec tauri signer generate -w ~/.tauri/hogsend-updater.key"
    echo "  then put its public key in src-tauri/tauri.conf.json (plugins.updater.pubkey)."
    exit 1
  }
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --- build (universal, signed) -------------------------------------------
echo "▸ Ensuring rust targets…"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

echo "▸ Building universal bundle (this takes a few minutes)…"
pnpm tauri build --target universal-apple-darwin

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
ARCHIVE="$(ls "$BUNDLE"/macos/*.app.tar.gz | head -1)"
SIG_FILE="${ARCHIVE}.sig"

[ -f "$DMG" ] || { echo "✗ dmg not found under $BUNDLE/dmg"; exit 1; }
[ -f "$ARCHIVE" ] || { echo "✗ updater archive not found (is createUpdaterArtifacts on?)"; exit 1; }
[ -f "$SIG_FILE" ] || { echo "✗ signature not found — signing key likely wrong"; exit 1; }

echo "  dmg:     $DMG"
echo "  archive: $ARCHIVE"

# --- updater manifest -----------------------------------------------------
SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo dougwithseismic/hogsend)"
ARCHIVE_URL="https://github.com/${SLUG}/releases/download/${TAG}/$(basename "$ARCHIVE")"
SIG="$(cat "$SIG_FILE")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

LATEST_JSON="$(mktemp -d)/latest.json"
# A universal binary runs on both arches, so point both platform keys at it.
# SIG is passed as an env var (prefix) — NOT an argv — so env.SIG is populated.
SIG="$SIG" node -e "
const fs = require('fs');
const sig = process.env.SIG;
if (!sig) { console.error('✗ empty updater signature'); process.exit(1); }
const m = {
  version: '${VERSION}',
  notes: 'Hogsend desktop ${VERSION}',
  pub_date: '${PUB_DATE}',
  platforms: {
    'darwin-aarch64': { signature: sig, url: '${ARCHIVE_URL}' },
    'darwin-x86_64':  { signature: sig, url: '${ARCHIVE_URL}' }
  }
};
fs.writeFileSync('${LATEST_JSON}', JSON.stringify(m, null, 2));
"

echo "▸ Manifest:"
cat "$LATEST_JSON"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "▸ --dry-run: built and signed, skipping publish."
  exit 0
fi

# --- publish --------------------------------------------------------------
# Versioned release: the human download + the archive the updater fetches.
# --latest=false so it never steals the repo's "Latest release" badge from the
# @hogsend/* npm tags.
if gh release view "$TAG" --repo "$SLUG" >/dev/null 2>&1; then
  echo "▸ Updating existing release $TAG…"
  gh release upload "$TAG" "$DMG" "$ARCHIVE" --repo "$SLUG" --clobber
else
  echo "▸ Creating release $TAG…"
  gh release create "$TAG" "$DMG" "$ARCHIVE" \
    --repo "$SLUG" --title "Hogsend Desktop v${VERSION}" \
    --notes "Menubar companion for Hogsend. Download the .dmg; installed copies auto-update." \
    --latest=false
fi

# Stable manifest release (machine-only): prerelease so it's never the badge.
if gh release view "$MANIFEST_TAG" --repo "$SLUG" >/dev/null 2>&1; then
  gh release upload "$MANIFEST_TAG" "$LATEST_JSON" --repo "$SLUG" --clobber
else
  gh release create "$MANIFEST_TAG" "$LATEST_JSON" \
    --repo "$SLUG" --title "Hogsend Desktop — updater manifest" \
    --notes "Auto-generated pointer consumed by the Tauri updater. Do not delete." \
    --prerelease
fi

echo "✓ Published ${TAG}"
echo "  Download: https://github.com/${SLUG}/releases/tag/${TAG}"
echo "  Updater feed: https://github.com/${SLUG}/releases/download/${MANIFEST_TAG}/latest.json"
