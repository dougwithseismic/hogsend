#!/usr/bin/env bash
# Phase 3 scaffold verification.
#
# Proves: build CLI -> pack @hogsend/* tarballs -> scaffold a fresh app in a
# clean /tmp dir (resolving @hogsend/* from those tarballs via file:) ->
# install -> check-types -> build -> biome check. Cleans up all /tmp dirs.
#
# No npm publish (tarballs only), no temp dirs in the repo, no DB mutation.
set -euo pipefail

# --- locate paths ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

PACKAGES=(attribution cli client core db email engine plugin-posthog plugin-resend sms studio)

TARBALLS=""
APP_PARENT=""
cleanup() {
  [ -n "$TARBALLS" ] && rm -rf "$TARBALLS"
  [ -n "$APP_PARENT" ] && rm -rf "$APP_PARENT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Assert a tarball contains a path matching a pattern. CRITICAL: capture the
# `tar` listing into a variable FIRST, then `grep` the string. Piping
# `tar -tzf … | grep -q …` instead lets grep's first-match early-exit close the
# pipe, sending GNU tar a SIGPIPE (exit 141); under `set -o pipefail` that
# propagates as a pipeline failure and FALSELY trips the check. (BSD/macOS tar
# does not exit non-zero on SIGPIPE, so this only ever bit CI, never local.)
tar_has() {
  local listing
  listing="$(tar -tzf "$1")"
  grep -q "$2" <<<"$listing"
}

# --- 1. build the CLI -----------------------------------------------------
echo "==> [1/8] build CLI"
pnpm --filter create-hogsend build >/dev/null
CLI="$PKG_DIR/dist/index.js"
[ -f "$CLI" ] || fail "CLI not built at $CLI"
head -1 "$CLI" | grep -q '#!/usr/bin/env node' || fail "missing shebang in $CLI"

# --- 2. pack @hogsend/* into a /tmp tarball dir ---------------------------
echo "==> [2/8] pack @hogsend/* tarballs"
TARBALLS="$(mktemp -d /tmp/hogsend-tarballs.XXXXXX)"
# Some packages ship a built `dist` bundle and must be built before packing or
# their tarballs are empty:
#   - studio (files: ["dist"]) — the engine serves the Studio UI from it.
#   - cli + client — both ship dist/ and are now on the engine version line, so
#     the scaffold depends on them (^{{ENGINE_VERSION}}). client ships only
#     dist; cli ships dist + src. Build all three first. The remaining packages
#     ship raw `src/**` and need no build.
pnpm --filter @hogsend/studio build >/dev/null
pnpm --filter @hogsend/cli build >/dev/null
pnpm --filter @hogsend/client build >/dev/null
for pkg in "${PACKAGES[@]}"; do
  # `pnpm pack` works on private packages. Run with --dir on the package path:
  # `--filter ... pack` is a recursive run, which pnpm's `pack` rejects.
  pnpm --dir "$REPO_ROOT/packages/$pkg" pack \
    --pack-destination "$TARBALLS" >/dev/null
  # Version-agnostic: the tarball is named for the package's own version, so
  # match the glob rather than hardcoding a version that drifts each release.
  tgz="$(echo "$TARBALLS"/hogsend-"$pkg"-*.tgz)"
  [ -f "$tgz" ] || fail "tarball not produced for $pkg (no hogsend-$pkg-*.tgz)"
  case "$pkg" in
    studio | cli | client)
      # These ship a built dist/ — assert it travelled in the tarball.
      tar_has "$tgz" 'package/dist/' || fail "$tgz missing package/dist/**"
      ;;
    *)
      tar_has "$tgz" 'package/src/' || fail "$tgz missing package/src/**"
      ;;
  esac
done
echo "    packed: $(ls "$TARBALLS" | tr '\n' ' ')"

# create-hogsend's OWN publish-time pack must carry the generated .claude tree +
# the CLAUDE.template.md orientation file. The harness runs the CLI from dist/,
# so this `pnpm pack` is the ONLY check that exercises real publish-time packing
# of template/.claude (build step 1 ran the prebuild that populates it).
echo "==> [2b] assert create-hogsend pack carries template/.claude + CLAUDE.template.md"
pnpm --dir "$PKG_DIR" pack --pack-destination "$TARBALLS" >/dev/null
chtgz="$(echo "$TARBALLS"/create-hogsend-*.tgz)"
[ -f "$chtgz" ] || fail "create-hogsend tarball not produced"
tar_has "$chtgz" 'package/template/.claude/skills/.*/SKILL.md' \
  || fail "create-hogsend pack missing template/.claude/skills/**/SKILL.md"
tar_has "$chtgz" 'package/template/CLAUDE.template.md' \
  || fail "create-hogsend pack missing template/CLAUDE.template.md"

# --- 3. scaffold into a clean /tmp dir ------------------------------------
echo "==> [3/8] scaffold my-app"
APP_PARENT="$(mktemp -d /tmp/hogsend-app.XXXXXX)"
APPDIR="$APP_PARENT/my-app"
(cd "$APP_PARENT" && node "$CLI" my-app --pm pnpm --no-install --no-git \
  --use-tarballs "$TARBALLS")

EXPECTED=(
  package.json src/index.ts src/worker.ts
  src/journeys/index.ts src/journeys/welcome.ts src/journeys/test-onboarding.ts
  src/journeys/ai-onboarding.ts
  src/journeys/constants/index.ts
  src/agents/index.ts src/agents/onboarding-concierge.ts
  src/lib/user-context.ts
  src/buckets/index.ts src/buckets/power-users.ts
  src/webhook-sources/index.ts src/webhook-sources/posthog.ts
  src/destinations/index.ts
  src/workflows/index.ts src/workflows/backfill-example.ts
  src/schema/index.ts scripts/migrate.ts scripts/bootstrap.ts
  drizzle.config.ts migrations/0000_init.sql migrations/meta/_journal.json
  migrations/meta/0000_snapshot.json
  docker-compose.yml railway.toml railway.worker.toml
  .env.example .node-version .gitignore pnpm-workspace.yaml
  biome.json vitest.config.ts tsconfig.json tsup.config.ts README.md
  CLAUDE.md .claude/README.md .claude/skills/hogsend-cli/SKILL.md
)
for f in "${EXPECTED[@]}"; do
  [ -e "$APPDIR/$f" ] || fail "missing scaffolded file: $f"
done

# token substitution + no residue
grep -q '"name": "my-app"' "$APPDIR/package.json" \
  || fail "APP_NAME token not applied in package.json"
grep -q 'file:.*hogsend-engine' "$APPDIR/package.json" \
  || fail "tarball file: dep not present in package.json"
# Scope past the copied skill bodies (.claude/), which legitimately document
# {{ }} templating; CLAUDE.md sits at the app root and IS token-substituted, so
# it stays covered by the residue check.
if grep -rq '{{' "$APPDIR" --exclude-dir=.claude; then
  fail "leftover {{ token in scaffold"
fi
if grep -q 'workspace:' "$APPDIR/package.json"; then
  fail "workspace: residue in package.json"
fi
# CLAUDE.md is token-substituted with the app name.
grep -q '# my-app' "$APPDIR/CLAUDE.md" \
  || fail "APP_NAME token not applied in CLAUDE.md"
# Vendored skills must be byte-identical to the canonical source (drift gate).
diff -r "$APPDIR/.claude/skills" "$REPO_ROOT/packages/cli/skills" \
  || fail ".claude/skills drifted from packages/cli/skills"
echo "    filesystem + tokens OK"

# --- 3b. --no-skills omits .claude + CLAUDE.md ----------------------------
echo "==> [3b] scaffold (--no-skills) omits .claude + CLAUDE.md"
NOSKILLS_DIR="$APP_PARENT/no-skills"
(cd "$APP_PARENT" && node "$CLI" no-skills --pm pnpm --no-install --no-git \
  --no-skills --use-tarballs "$TARBALLS")
[ -e "$NOSKILLS_DIR/package.json" ] || fail "--no-skills produced no app"
[ ! -e "$NOSKILLS_DIR/.claude" ] || fail "--no-skills emitted .claude/"
[ ! -e "$NOSKILLS_DIR/CLAUDE.md" ] || fail "--no-skills emitted CLAUDE.md"
echo "    --no-skills OK"

# --- 3c. --posthog-key materializes active PostHog env --------------------
echo "==> [3c] scaffold (--posthog-key) writes active PostHog env"
POSTHOG_DIR="$APP_PARENT/with-posthog"
(cd "$APP_PARENT" && node "$CLI" with-posthog --pm pnpm --no-install --no-git \
  --posthog-key phc_verify_test --posthog-host https://eu.i.posthog.com \
  --use-tarballs "$TARBALLS")
[ -e "$POSTHOG_DIR/.env.example" ] \
  || fail "--posthog-key scaffold produced no .env.example"
# CRITICAL: capture the file into a variable FIRST, then grep a here-string.
# A `cat … | grep -q` pipeline can SIGPIPE the producer under
# `set -o pipefail` and falsely trip the check (same gotcha as tar_has above).
POSTHOG_ENV="$(cat "$POSTHOG_DIR/.env.example")"
grep -q '^POSTHOG_API_KEY=phc_verify_test$' <<<"$POSTHOG_ENV" \
  || fail "active POSTHOG_API_KEY not written by --posthog-key"
grep -q '^POSTHOG_HOST=https://eu.i.posthog.com$' <<<"$POSTHOG_ENV" \
  || fail "active POSTHOG_HOST not written by --posthog-host"
grep -q '^ENABLE_POSTHOG_DESTINATION=true$' <<<"$POSTHOG_ENV" \
  || fail "ENABLE_POSTHOG_DESTINATION not activated"
grep -Eq '^POSTHOG_WEBHOOK_SECRET=[0-9a-f]{64}$' <<<"$POSTHOG_ENV" \
  || fail "POSTHOG_WEBHOOK_SECRET not minted (expected 64 hex chars)"
# Without the PostHog flags, the env must be UNTOUCHED — the default scaffold
# from step 3 keeps .env.example byte-identical to the template.
diff -q "$APPDIR/.env.example" "$PKG_DIR/template/env.example" >/dev/null \
  || fail "default scaffold .env.example drifted from template/env.example \
(skipping PostHog must be a no-op)"
echo "    --posthog-key env OK"

# --- 4. install -----------------------------------------------------------
# Plain `pnpm install`, NOT --ignore-workspace: the scaffold ships its own
# pnpm-workspace.yaml (settings root: allowBuilds + minimumReleaseAgeExclude,
# packages: []), which BOTH stops pnpm from joining any parent workspace AND
# carries the pnpm 11 build-script approvals. --ignore-workspace would discard
# that settings file and resurrect ERR_PNPM_IGNORED_BUILDS on pnpm >= 11.
echo "==> [4/8] pnpm install (scaffolded app)"
(cd "$APPDIR" && pnpm install >/dev/null 2>&1) \
  || fail "pnpm install failed"
[ -f "$APPDIR/node_modules/@hogsend/engine/src/index.ts" ] \
  || fail "engine raw .ts not present in node_modules (tarball did not carry src)"

# --- 5. check-types -------------------------------------------------------
echo "==> [5/8] pnpm check-types (scaffolded app)"
(cd "$APPDIR" && pnpm check-types) || fail "check-types failed"

# --- 6. build -------------------------------------------------------------
echo "==> [6/9] pnpm build (scaffolded app)"
(cd "$APPDIR" && pnpm build >/dev/null) || fail "build failed"
[ -f "$APPDIR/dist/index.js" ] || fail "dist/index.js not produced"
[ -f "$APPDIR/dist/worker.js" ] || fail "dist/worker.js not produced"

# --- 7. boot smoke --------------------------------------------------------
# The AI-SDK bundling bug ("Dynamic require of X is not supported") throws at
# MODULE EVAL — before any DB/Redis connection — so a build-only smoke misses
# it (this is exactly how engine 0.35.0 shipped a consumer-crashing release).
# We can't assert on exit code: with no .env the app legitimately exits non-zero
# at env-validation, which is itself PROOF the module graph loaded fine. So we
# boot each entry (timeout-bounded) and FAIL only on the telltale module-eval
# signatures — reaching env-validation (or staying up to the timeout) is a PASS.
echo "==> [7/9] boot smoke (node dist/index.js + dist/worker.js)"
for entry in index worker; do
  log="/tmp/hogsend-boot-$entry.log"
  (cd "$APPDIR" && timeout 8 node "dist/$entry.js" >"$log" 2>&1) || true
  if grep -qiE 'Dynamic require|is not supported|Cannot use import statement|SyntaxError|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM' "$log"; then
    echo "----- boot output ($entry) -----" >&2; cat "$log" >&2
    fail "dist/$entry.js failed at module eval — a CJS dep was bundled into ESM; add it to template/_package.json dependencies so tsup externalizes it"
  fi
  echo "    dist/$entry.js loads clean (no module-eval crash)"
done

# --- 8. lint --------------------------------------------------------------
echo "==> [8/9] biome check (scaffolded app)"
(cd "$APPDIR" && pnpm exec biome check .) || fail "biome check failed"

# --- 9. cleanup (trap) ----------------------------------------------------
echo "==> [9/9] cleanup /tmp dirs"
echo ""
echo "PASS: scaffold -> install -> check-types -> build -> boot -> lint all green."
