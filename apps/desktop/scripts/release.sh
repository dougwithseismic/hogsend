#!/usr/bin/env bash
#
# Local release for the Hogsend desktop companion. Build on your own machine,
# push live — no CI runner. Cross-platform:
#   - on macOS  → a signed universal (Intel + Apple Silicon) .dmg
#   - on Windows (Git Bash / MSYS) → a signed NSIS .exe installer
#
# Each run publishes a versioned GitHub Release and MERGES this platform's entry
# into the stable updater manifest, so macOS and Windows builds (cut separately,
# on their own machines) coexist in one `latest.json` feed.
#
# Usage:
#   pnpm --filter @hogsend/desktop release            # build + publish
#   pnpm --filter @hogsend/desktop release --dry-run  # build + sign only
#
# Prereqs (one-time):
#   - gh CLI authed (`gh auth status`)
#   - updater key at ~/.tauri/hogsend-updater.key (from `tauri signer generate`),
#     or export TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH.
#   - Windows also needs the MSVC build tools + NSIS (Tauri prompts/handles NSIS).
#
# Versioning: bump src-tauri/tauri.conf.json (and package.json / Cargo.toml to
# match), then run this. The tag is desktop-v<version>.

set -euo pipefail

cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

MANIFEST_TAG="desktop-latest"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="desktop-v${VERSION}"

# Version parity: the updater compares the manifest version against the version
# baked into the binary at build time, so all three must agree (H5).
PKG_VERSION="$(node -p "require('./package.json').version")"
CARGO_VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed -E 's/version = "(.*)"/\1/')"
if [ "$VERSION" != "$PKG_VERSION" ] || [ "$VERSION" != "$CARGO_VERSION" ]; then
  echo "✗ Version mismatch — align all three before releasing:"
  echo "    tauri.conf.json: $VERSION"
  echo "    package.json:    $PKG_VERSION"
  echo "    Cargo.toml:      $CARGO_VERSION"
  exit 1
fi

# --- detect build host ----------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=macos ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) OS=windows ;;
  *) echo "✗ Unsupported build host ($(uname -s)); build on macOS or Windows."; exit 1 ;;
esac

echo "▸ Hogsend desktop ${VERSION} (${OS}, tag ${TAG})"

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
# Password falls back to the sibling file written by `tauri signer generate`, so
# local releases don't need it re-exported each time. (CI passes it as a secret.)
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  PW_FILE="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH:-$HOME/.tauri/hogsend-updater.password}"
  [ -f "$PW_FILE" ] && TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PW_FILE")"
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --- build (signed) -------------------------------------------------------
# DOWNLOAD_ASSET = the human installer; UPDATER_ASSET = what the manifest URL
# points at (the same file on Windows; the .app.tar.gz on macOS).
if [ "$OS" = macos ]; then
  echo "▸ Ensuring rust targets…"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  echo "▸ Building universal bundle (a few minutes)…"
  pnpm tauri build --target universal-apple-darwin
  BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
  dmgs=("$BUNDLE"/dmg/*.dmg)
  archives=("$BUNDLE"/macos/*.app.tar.gz)
  DOWNLOAD_ASSET="${dmgs[0]}"
  UPDATER_ASSET="${archives[0]}"
  STABLE_NAME="Hogsend.dmg"
  PLATFORM_KEYS="darwin-aarch64 darwin-x86_64"
else
  echo "▸ Building Windows installer (a few minutes)…"
  pnpm tauri build
  BUNDLE="src-tauri/target/release/bundle"
  exes=("$BUNDLE"/nsis/*-setup.exe)
  # The NSIS installer is both the download and the updater payload on Windows.
  DOWNLOAD_ASSET="${exes[0]}"
  UPDATER_ASSET="${exes[0]}"
  STABLE_NAME="Hogsend-setup.exe"
  PLATFORM_KEYS="windows-x86_64"
fi
SIG_FILE="${UPDATER_ASSET}.sig"

[ -f "$DOWNLOAD_ASSET" ] || { echo "✗ installer not found under $BUNDLE"; exit 1; }
[ -f "$UPDATER_ASSET" ] || { echo "✗ updater asset not found (is createUpdaterArtifacts on?)"; exit 1; }
[ -f "$SIG_FILE" ] || { echo "✗ signature not found — signing key likely wrong"; exit 1; }

echo "  installer: $DOWNLOAD_ASSET"
echo "  updater:   $UPDATER_ASSET"

# --- updater manifest (merge this platform into the existing feed) --------
SLUG="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo dougwithseismic/hogsend)"
FEED_URL="https://github.com/${SLUG}/releases/download/${MANIFEST_TAG}/latest.json"
ARCHIVE_URL="https://github.com/${SLUG}/releases/download/${TAG}/$(basename "$UPDATER_ASSET")"
STABLE_URL="https://github.com/${SLUG}/releases/download/${MANIFEST_TAG}/${STABLE_NAME}"

# Pull the current feed (if any) so we preserve the OTHER platform's entry.
curl -fsSL "$FEED_URL" -o "$TMP/existing.json" 2>/dev/null || true

LATEST_JSON="$TMP/latest.json"
cat > "$TMP/merge.js" <<'JS'
const fs = require("fs");
const version = process.env.HS_VERSION;
const out = {
  version,
  notes: `Hogsend desktop ${version}`,
  pub_date: process.env.HS_PUBDATE,
  platforms: {},
};
// Keep other platforms ONLY if the existing feed is for this same version —
// otherwise they're stale (built against an older release).
const prevPath = process.env.HS_EXISTING;
if (prevPath && fs.existsSync(prevPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
    if (prev && prev.version === version && prev.platforms) {
      out.platforms = { ...prev.platforms };
    }
  } catch {}
}
const sig = process.env.HS_SIG;
const url = process.env.HS_URL;
if (!sig) { console.error("empty updater signature"); process.exit(1); }
for (const key of process.env.HS_KEYS.split(/\s+/).filter(Boolean)) {
  out.platforms[key] = { signature: sig, url };
}
fs.writeFileSync(process.env.HS_OUT, JSON.stringify(out, null, 2));
JS

HS_VERSION="$VERSION" \
HS_PUBDATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
HS_SIG="$(cat "$SIG_FILE")" \
HS_URL="$ARCHIVE_URL" \
HS_KEYS="$PLATFORM_KEYS" \
HS_EXISTING="$TMP/existing.json" \
HS_OUT="$LATEST_JSON" \
  node "$TMP/merge.js"

echo "▸ Manifest:"
cat "$LATEST_JSON"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "▸ --dry-run: built and signed, skipping publish."
  exit 0
fi

# --- publish --------------------------------------------------------------
# Versioned release: human download + the updater asset. --latest=false so it
# never steals the repo's "Latest release" badge from the @hogsend/* npm tags.
RELEASE_ASSETS=("$DOWNLOAD_ASSET")
[ "$UPDATER_ASSET" != "$DOWNLOAD_ASSET" ] && RELEASE_ASSETS+=("$UPDATER_ASSET")

if gh release view "$TAG" --repo "$SLUG" >/dev/null 2>&1; then
  echo "▸ Updating release ${TAG}…"
  gh release upload "$TAG" "${RELEASE_ASSETS[@]}" --repo "$SLUG" --clobber
else
  echo "▸ Creating release ${TAG}…"
  gh release create "$TAG" "${RELEASE_ASSETS[@]}" \
    --repo "$SLUG" --title "Hogsend Desktop v${VERSION}" \
    --notes "Desktop companion for Hogsend. Download the installer for your OS; installed copies auto-update." \
    --latest=false
fi

# Stable manifest release (machine-only): prerelease so it's never the badge.
# Per-OS stable asset names (Hogsend.dmg / Hogsend-setup.exe) don't collide, so
# clobbering one platform never disturbs the other's download.
STABLE_ASSET="$TMP/$STABLE_NAME"
cp "$DOWNLOAD_ASSET" "$STABLE_ASSET"

if gh release view "$MANIFEST_TAG" --repo "$SLUG" >/dev/null 2>&1; then
  gh release upload "$MANIFEST_TAG" "$STABLE_ASSET" "$LATEST_JSON" --repo "$SLUG" --clobber
else
  gh release create "$MANIFEST_TAG" "$STABLE_ASSET" "$LATEST_JSON" \
    --repo "$SLUG" --title "Hogsend Desktop — latest" \
    --notes "Auto-generated downloads + updater feed. Managed by scripts/release.sh — do not delete." \
    --prerelease
fi

# --- verify the published feed actually resolves --------------------------
# Freshly-uploaded release assets take a little while to appear on GitHub's
# download CDN, so poll with backoff before declaring the feed broken.
FIRST_KEY="${PLATFORM_KEYS%% *}"
echo "▸ Verifying updater feed…"
fetched=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsSL "$FEED_URL" -o "$TMP/fetched.json" 2>/dev/null; then
    fetched=1
    break
  fi
  echo "  feed not propagated yet (attempt ${attempt})…"
  sleep 10
done
[ "$fetched" = "1" ] || { echo "✗ feed not reachable after retries: $FEED_URL"; exit 1; }
ARCH_URL="$(HS_KEY="$FIRST_KEY" HS_VERSION="$VERSION" node -e "
const m = require('$TMP/fetched.json');
if (m.version !== process.env.HS_VERSION) { console.error('version '+m.version+' != '+process.env.HS_VERSION); process.exit(1); }
const p = m.platforms && m.platforms[process.env.HS_KEY];
if (!p || !p.url || !p.signature) { console.error('missing '+process.env.HS_KEY+' url/signature'); process.exit(1); }
process.stdout.write(p.url);
")" || { echo "✗ published manifest is invalid for $FIRST_KEY"; exit 1; }
reachable() {
  for _ in 1 2 3 4 5 6; do
    curl -fsIL "$1" >/dev/null 2>&1 && return 0
    sleep 10
  done
  return 1
}
reachable "$ARCH_URL" || { echo "✗ updater asset not reachable: $ARCH_URL"; exit 1; }
reachable "$STABLE_URL" || { echo "✗ stable download not reachable: $STABLE_URL"; exit 1; }

echo "✓ Published ${TAG} (${OS}, feed verified)"
echo "  Download (stable): $STABLE_URL"
echo "  Release:           https://github.com/${SLUG}/releases/tag/${TAG}"
echo "  Updater feed:      $FEED_URL"
