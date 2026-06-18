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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Stable tag that only ever holds latest.json + a stable-named dmg — the updater
# endpoint and the docs "Download" link point here, so it must not collide with
# the per-package npm release tags.
MANIFEST_TAG="desktop-latest"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="desktop-v${VERSION}"

# Version parity: the updater compares the manifest version against the version
# baked into the binary at build time, so tauri.conf.json / package.json /
# Cargo.toml must agree or updates silently mis-gate (H5).
PKG_VERSION="$(node -p "require('./package.json').version")"
CARGO_VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed -E 's/version = "(.*)"/\1/')"
if [ "$VERSION" != "$PKG_VERSION" ] || [ "$VERSION" != "$CARGO_VERSION" ]; then
  echo "✗ Version mismatch — align all three before releasing:"
  echo "    tauri.conf.json: $VERSION"
  echo "    package.json:    $PKG_VERSION"
  echo "    Cargo.toml:      $CARGO_VERSION"
  exit 1
fi

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
# Globs into arrays (no `ls` parsing / no SIGPIPE under pipefail).
dmgs=("$BUNDLE"/dmg/*.dmg)
archives=("$BUNDLE"/macos/*.app.tar.gz)
DMG="${dmgs[0]}"
ARCHIVE="${archives[0]}"
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

LATEST_JSON="$TMP/latest.json"
# A universal binary runs on both arches, so point both platform keys at it.
# (Do NOT collapse to a single "darwin-universal" key — the updater resolves
#  darwin-aarch64 / darwin-x86_64 at runtime and would 404 on "universal".)
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
# Holds latest.json (the updater feed) + a stable-named dmg (the docs download
# link). gh `--clobber` deletes-then-uploads each asset, so we verify the feed
# afterwards (below) and fail loudly if the swap left it broken (H2).
STABLE_DMG="$TMP/Hogsend.dmg"
cp "$DMG" "$STABLE_DMG"

if gh release view "$MANIFEST_TAG" --repo "$SLUG" >/dev/null 2>&1; then
  gh release upload "$MANIFEST_TAG" "$STABLE_DMG" "$LATEST_JSON" --repo "$SLUG" --clobber
else
  gh release create "$MANIFEST_TAG" "$STABLE_DMG" "$LATEST_JSON" \
    --repo "$SLUG" --title "Hogsend Desktop — latest" \
    --notes "Auto-generated download + updater feed. Managed by scripts/release.sh — do not delete." \
    --prerelease
fi

# --- verify the published feed actually resolves --------------------------
FEED_URL="https://github.com/${SLUG}/releases/download/${MANIFEST_TAG}/latest.json"
DMG_URL="https://github.com/${SLUG}/releases/download/${MANIFEST_TAG}/Hogsend.dmg"
echo "▸ Verifying updater feed…"
curl -fsSL "$FEED_URL" -o "$TMP/fetched.json" \
  || { echo "✗ feed not reachable: $FEED_URL"; exit 1; }
ARCH_URL="$(node -e "
const m = require('$TMP/fetched.json');
if (m.version !== '${VERSION}') { console.error('version '+m.version+' != ${VERSION}'); process.exit(1); }
const p = m.platforms && m.platforms['darwin-aarch64'];
if (!p || !p.url || !p.signature) { console.error('missing url/signature'); process.exit(1); }
process.stdout.write(p.url);
")" || { echo "✗ published manifest is invalid"; exit 1; }
curl -fsIL "$ARCH_URL" >/dev/null || { echo "✗ updater archive not reachable: $ARCH_URL"; exit 1; }
curl -fsIL "$DMG_URL" >/dev/null || { echo "✗ stable dmg not reachable: $DMG_URL"; exit 1; }

echo "✓ Published ${TAG} (feed verified)"
echo "  Download (stable): $DMG_URL"
echo "  Release:           https://github.com/${SLUG}/releases/tag/${TAG}"
echo "  Updater feed:      $FEED_URL"
