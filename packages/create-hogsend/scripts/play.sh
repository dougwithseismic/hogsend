#!/usr/bin/env bash
# Scaffolding-experience playground.
#
# Runs the REAL interactive `create-hogsend` from THIS checkout (built CLI +
# `--use-tarballs` so every @hogsend/* resolves to the local, unpublished
# code) in a fresh directory — so you can feel the exact first-run experience
# a new user gets, tweak prompts/template/bootstrap, and re-run.
#
#   bash packages/create-hogsend/scripts/play.sh              # full interactive run
#   bash packages/create-hogsend/scripts/play.sh my-app --pm pnpm   # flags pass through
#   bash packages/create-hogsend/scripts/play.sh --repack     # re-pack after engine/db/etc. edits
#
# Iteration map:
#   template/** (bootstrap.ts, env.example, CLAUDE.template.md, src/…)
#       → live, no rebuild — just re-run this script
#   src/**   (prompts.ts, index.ts, copy.ts)
#       → picked up automatically (this script rebuilds the CLI every run)
#   packages/engine|db|cli|…
#       → re-run with --repack (rebuilds dists + re-packs the tarballs)
#
# Env knobs:
#   HOGSEND_PLAY_DIR       parent for playground apps  (default /tmp/hogsend-play)
#                          — point it at a path WITH SPACES to test that class of bug
#   HOGSEND_PLAY_TARBALLS  tarball cache               (default /tmp/hogsend-play-tarballs)
#
# Cleanup: each app is self-contained — `docker compose down -v` inside it,
# then delete the folder (or just `rm -rf /tmp/hogsend-play` after downing).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

TARBALLS="${HOGSEND_PLAY_TARBALLS:-/tmp/hogsend-play-tarballs}"
PLAY_PARENT="${HOGSEND_PLAY_DIR:-/tmp/hogsend-play}"

REPACK=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --repack) REPACK=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

echo "==> build create-hogsend CLI"
pnpm --dir "$REPO_ROOT" --filter create-hogsend build >/dev/null

if [ "$REPACK" = 1 ] || [ ! -e "$TARBALLS/hogsend-engine-"*.tgz ]; then
  echo "==> pack @hogsend/* tarballs → $TARBALLS"
  rm -rf "$TARBALLS"
  bash "$SCRIPT_DIR/pack-tarballs.sh" "$TARBALLS"
else
  echo "==> reusing tarballs in $TARBALLS  (pass --repack after package edits)"
fi

RUN_DIR="$PLAY_PARENT/run-$(date +%H%M%S)"
mkdir -p "$RUN_DIR"
cd "$RUN_DIR"
echo "==> playground: $RUN_DIR"
echo ""
# exec so Ctrl-C, TTY prompts and exit codes are exactly the real thing.
exec node "$PKG_DIR/dist/index.js" ${ARGS[@]+"${ARGS[@]}"} --use-tarballs "$TARBALLS"
