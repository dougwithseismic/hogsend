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

PACKAGES=(attribution cli client core db email engine js plugin-posthog plugin-resend sms studio testing)
# Opt-in provider plugins (`create-hogsend --with <id>`). NOT scaffold defaults,
# so deliberately a separate list — release-doctor asserts PACKAGES above stays
# equal to HOGSEND_PACKAGES + template/_package.json.
OPT_IN_PLUGINS=(plugin-apollo plugin-hogsend plugin-postmark plugin-twilio)

mkdir -p "$DEST"

# These ship a built dist/ and must be built before packing or their tarballs
# are empty (the opt-in plugins' runtime entry is dist/ since #611 — Node
# refuses to type-strip raw .ts under node_modules). One batched invocation:
# workspace resolution is paid once and pnpm parallelizes independent builds.
pnpm --dir "$REPO_ROOT" --filter @hogsend/studio --filter @hogsend/cli \
  --filter @hogsend/client --filter @hogsend/js --filter @hogsend/plugin-apollo \
  --filter @hogsend/plugin-hogsend --filter @hogsend/plugin-postmark \
  --filter @hogsend/plugin-twilio \
  build >/dev/null

for pkg in "${PACKAGES[@]}" "${OPT_IN_PLUGINS[@]}"; do
  # `pnpm pack` works on private packages. Run with --dir on the package path:
  # `--filter ... pack` is a recursive run, which pnpm's `pack` rejects.
  pnpm --dir "$REPO_ROOT/packages/$pkg" pack --pack-destination "$DEST" >/dev/null
done
