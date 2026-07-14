#!/usr/bin/env bash
# Shared tarball production for the --use-tarballs harnesses
# (verify-scaffold.sh + play.sh): build the dist-shipping packages, then
# `pnpm pack` every @hogsend/* the scaffold depends on into $1.
#
#   pack-tarballs.sh <destination-dir>
#
# HOGSEND_PACKAGES is the canonical list (src/template-manifest.ts) — keep
# this shell mirror in sync when scaffold-pinning a new package, or tarball
# runs resolve it from the registry (stale or 404).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEST="${1:?usage: pack-tarballs.sh <destination-dir>}"

PACKAGES=(attribution cli client core db email engine plugin-posthog plugin-resend sms studio)

mkdir -p "$DEST"

# These three ship a built dist/ and must be built before packing or their
# tarballs are empty. One batched invocation: workspace resolution is paid
# once and pnpm parallelizes the independent builds.
pnpm --dir "$REPO_ROOT" --filter @hogsend/studio --filter @hogsend/cli \
  --filter @hogsend/client build >/dev/null

for pkg in "${PACKAGES[@]}"; do
  # `pnpm pack` works on private packages. Run with --dir on the package path:
  # `--filter ... pack` is a recursive run, which pnpm's `pack` rejects.
  pnpm --dir "$REPO_ROOT/packages/$pkg" pack --pack-destination "$DEST" >/dev/null
done
