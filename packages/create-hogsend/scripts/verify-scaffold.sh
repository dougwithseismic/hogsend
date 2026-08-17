#!/usr/bin/env bash
# Phase 3 scaffold verification.
#
# Proves: build CLI -> pack @hogsend/* tarballs -> scaffold a fresh app in a
# clean /tmp dir (resolving @hogsend/* from those tarballs via file:) ->
# clean-consumer import/typecheck -> scaffold install -> check-types -> build ->
# biome check. Cleans up all /tmp dirs.
#
# No npm publish (tarballs only), no temp dirs in the repo, no DB mutation.
set -euo pipefail

# --- locate paths ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

PACKAGES=(attribution cli client core db email engine js plugin-posthog plugin-resend sms studio testing)
# Opt-in provider plugins (`--with <id>`). NOT scaffold defaults — a separate
# list because release-doctor asserts PACKAGES above equals HOGSEND_PACKAGES +
# the template's @hogsend deps, and these belong to neither.
OPT_IN_PLUGINS=(plugin-apollo plugin-hogsend plugin-postmark plugin-twilio)

TARBALLS=""
APP_PARENT=""
CONSUMER_DIR=""
cleanup() {
  [ -n "$TARBALLS" ] && rm -rf "$TARBALLS"
  [ -n "$APP_PARENT" ] && rm -rf "$APP_PARENT"
  [ -n "$CONSUMER_DIR" ] && rm -rf "$CONSUMER_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# When `check-types` fails, say WHOSE fault it is.
#
# A scaffolded app type-checks @hogsend/engine's raw .ts against whatever
# versions npm resolved, so ONE dependency shipping broken type declarations
# fails the scaffold with a wall of errors inside node_modules — none of them in
# code the user wrote. That happened for real: `@hono/zod-openapi@1.5.2` stopped
# importing `z` from zod (`import z = zodModule.z`, where `zodModule` is never
# declared), `z` degraded to `any`, and a fresh scaffold failed with 33
# TS7006/TS7053 implicit-any errors inside the engine. The message was
# "check-types failed", which sends you reading your own code for a defect that
# is not there.
#
# Worse, `skipLibCheck: true` — which the scaffold sets, correctly — SUPPRESSES
# the one error that names the culprit (TS2503 "Cannot find namespace"). So the
# diagnosis re-runs tsc with library checking ON purely to surface that name.
# It never gates: this runs only after a failure and only to explain it.
diagnose_dependency_types() {
  log="$1"
  appdir="$2"

  total=$(grep -cE 'error TS[0-9]+' "$log" 2>/dev/null || true)
  in_deps=$(grep -E 'error TS[0-9]+' "$log" 2>/dev/null | grep -cE '(^|[ (])[^ ]*node_modules/' || true)
  [ "${in_deps:-0}" -eq 0 ] && return 0

  # `node_modules/.pnpm/@hono+zod-openapi@1.5.2_.../node_modules/@hono/…` and the
  # plain `node_modules/@scope/name/…` layout both reduce to <name>@<version>.
  # `|| true` on BOTH: a no-match grep exits 1, and under `set -euo pipefail` a
  # failing command substitution kills the script — which would make this
  # diagnostic silently abort the run it exists to explain. Measured: without
  # it, a flat (non-pnpm) node_modules layout produced no output at all.
  packages=$(grep -E 'error TS[0-9]+' "$log" \
    | grep -oE 'node_modules/\.pnpm/[^/]+' \
    | sed 's|node_modules/\.pnpm/||' \
    | sed 's/_.*$//' \
    | sed 's/+/\//' \
    | sort -u || true)
  if [ -z "$packages" ]; then
    packages=$(grep -E 'error TS[0-9]+' "$log" \
      | grep -oE 'node_modules/(@[^/]+/)?[^/]+' \
      | sed 's|node_modules/||' | sort -u || true)
  fi
  [ -z "$packages" ] && packages="(could not identify the package from the paths)"

  {
    echo
    echo "── diagnosis ────────────────────────────────────────────────────"
    echo "${in_deps} of ${total} type errors are inside node_modules, not in the"
    echo "scaffolded app's own code. A dependency is shipping broken type"
    echo "declarations. Suspect package(s):"
    echo "$packages" | sed 's/^/    /'
    echo
    echo "Re-running tsc WITHOUT skipLibCheck to surface the declaration error"
    echo "that names the cause (skipLibCheck hides exactly that error):"
  } >&2

  (cd "$appdir" && pnpm exec tsc -p tsconfig.json --noEmit --skipLibCheck false 2>&1) \
    | grep -E 'error TS(2503|2304|2307|2688)' | head -8 | sed 's/^/    /' >&2 || true

  {
    echo
    echo "If the named package is at fault, pin it in package.json AND in"
    echo "pnpm-workspace.yaml overrides (the pin alone stops protecting you the"
    echo "day the direct dependency is removed), then re-run."
    echo "─────────────────────────────────────────────────────────────────"
  } >&2
}

# macOS ships no `timeout(1)`. Without this, the boot smokes put "timeout:
# command not found" in the log, `|| true` swallows it, and every negative
# grep passes VACUOUSLY — the boot never ran. Fall back to gtimeout
# (coreutils) or a perl alarm+exec guard (alarm survives exec) so the smokes
# execute everywhere, not only on Linux CI.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT=gtimeout
else
  timeout_fallback() { perl -e 'alarm shift; exec @ARGV' "$@"; }
  TIMEOUT=timeout_fallback
fi

REPO_PACKAGE_MANAGER="$(node -p "require('$REPO_ROOT/package.json').packageManager")"
EXPECTED_PNPM="${REPO_PACKAGE_MANAGER#pnpm@}"
ACTUAL_PNPM="$(pnpm --version)"
[ "$REPO_PACKAGE_MANAGER" = "pnpm@$EXPECTED_PNPM" ] \
  || fail "root packageManager must pin pnpm"
[ "$ACTUAL_PNPM" = "$EXPECTED_PNPM" ] \
  || fail "expected pnpm $EXPECTED_PNPM from root packageManager, got $ACTUAL_PNPM"
echo "==> toolchain: $REPO_PACKAGE_MANAGER"

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

tarball_for() {
  local pkg="$1"
  local matches=("$TARBALLS"/hogsend-"$pkg"-*.tgz)
  [ "${#matches[@]}" -eq 1 ] && [ -f "${matches[0]}" ] \
    || fail "expected exactly one tarball for $pkg"
  printf '%s' "${matches[0]}"
}

assert_runtime_deps() {
  local tgz="$1"
  shift
  local manifest
  manifest="$(tar -xOf "$tgz" package/package.json)"
  PACKAGE_JSON="$manifest" node - "$@" <<'NODE'
const pkg = JSON.parse(process.env.PACKAGE_JSON);
for (const name of process.argv.slice(2)) {
  if (!pkg.dependencies?.[name]) {
    console.error(`${pkg.name} must publish ${name} in dependencies`);
    process.exitCode = 1;
  }
}
NODE
}

# --- 1. build the CLI -----------------------------------------------------
# Every `pnpm --filter` here carries `--dir "$REPO_ROOT"` so the harness
# builds THIS checkout regardless of the caller's cwd — without it, running
# the script from another checkout (e.g. the main repo while testing a
# worktree) silently builds the WRONG tree and packs stale dist output.
echo "==> [1/10] build CLI"
pnpm --dir "$REPO_ROOT" --filter create-hogsend build >/dev/null
CLI="$PKG_DIR/dist/index.js"
[ -f "$CLI" ] || fail "CLI not built at $CLI"
head -1 "$CLI" | grep -q '#!/usr/bin/env node' || fail "missing shebang in $CLI"

# --- 2. pack @hogsend/* into a /tmp tarball dir ---------------------------
echo "==> [2/10] pack @hogsend/* tarballs"
TARBALLS="$(mktemp -d /tmp/hogsend-tarballs.XXXXXX)"
bash "$SCRIPT_DIR/pack-tarballs.sh" "$TARBALLS"
for pkg in "${PACKAGES[@]}"; do
  # Version-agnostic: the tarball is named for the package's own version, so
  # match the glob rather than hardcoding a version that drifts each release.
  tgz="$(tarball_for "$pkg")"
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
# The opt-in plugins ship a BUILT dist/ as their runtime entry — raw .ts under
# node_modules dies on Node's type-stripping refusal, which is exactly how
# #611 shipped. Assert the dist actually travelled.
for pkg in "${OPT_IN_PLUGINS[@]}"; do
  tgz="$(tarball_for "$pkg")"
  tar_has "$tgz" 'package/dist/' || fail "$tgz missing package/dist/**"
done
echo "    packed: $(ls "$TARBALLS" | tr '\n' ' ')"

testing_tgz="$(tarball_for testing)"
if tar_has "$testing_tgz" '\.test\.ts$'; then
  fail "@hogsend/testing tarball contains internal *.test.ts files"
fi
assert_runtime_deps "$(tarball_for email)" react-email @types/react @types/react-dom
assert_runtime_deps "$(tarball_for sms)" react-email @types/react @types/react-dom
assert_runtime_deps "$testing_tgz" @hogsend/sms @types/react @types/react-dom
echo "    runtime dependency metadata + testing tarball surface OK"

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

# The scaffold intentionally carries extra development dependencies. Verify the
# published testing package independently so react-email / React declarations
# cannot be supplied accidentally by template/_package.json. Only compiler and
# raw-TypeScript loader tooling is installed alongside @hogsend/testing.
echo "==> [2c] clean packed-consumer runtime import + tsc"
CONSUMER_DIR="$(mktemp -d /tmp/hogsend-consumer.XXXXXX)"
cat >"$CONSUMER_DIR/package.json" <<EOF
{
  "name": "hogsend-packed-consumer",
  "private": true,
  "type": "module",
  "packageManager": "$REPO_PACKAGE_MANAGER",
  "dependencies": {
    "@hogsend/testing": "file:$testing_tgz"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "tsx": "^4.22.3",
    "typescript": "5.9.2"
  }
}
EOF

{
  echo 'packages: []'
  echo
  echo 'overrides:'
  for pkg in attribution core db email engine plugin-posthog plugin-resend sms; do
    printf '  "@hogsend/%s": "file:%s"\n' "$pkg" "$(tarball_for "$pkg")"
  done
} >"$CONSUMER_DIR/pnpm-workspace.yaml"

cat >"$CONSUMER_DIR/smoke.ts" <<'EOF'
import { createJourneyTest, runJourneyScenarios } from "@hogsend/testing";

if (
  typeof createJourneyTest !== "function" ||
  typeof runJourneyScenarios !== "function"
) {
  throw new Error("@hogsend/testing did not expose its runtime API");
}
EOF

cat >"$CONSUMER_DIR/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["smoke.ts"]
}
EOF

CONSUMER_INSTALL_LOG="$CONSUMER_DIR/install.log"
if ! (cd "$CONSUMER_DIR" && pnpm install --ignore-scripts >"$CONSUMER_INSTALL_LOG" 2>&1); then
  echo "----- clean consumer pnpm install output -----" >&2
  tail -40 "$CONSUMER_INSTALL_LOG" >&2
  fail "clean packed-consumer install failed"
fi
(cd "$CONSUMER_DIR" && pnpm exec tsx smoke.ts) \
  || fail "clean packed-consumer runtime import failed"
(cd "$CONSUMER_DIR" && pnpm exec tsc -p tsconfig.json) \
  || fail "clean packed-consumer typecheck failed"
echo "    clean consumer imports + typechecks without scaffold React dependencies"

# --- 3. scaffold into a clean /tmp dir ------------------------------------
# The verified app carries `--with apollo` so the whole install → build → boot
# chain proves an opt-in plugin is genuinely LOADABLE from a scaffolded app —
# the #611 regression test (direct dependency + built dist runtime entry).
echo "==> [3/10] scaffold my-app (--with apollo)"
APP_PARENT="$(mktemp -d /tmp/hogsend-app.XXXXXX)"
APPDIR="$APP_PARENT/my-app"
(cd "$APP_PARENT" && node "$CLI" my-app --pm pnpm --no-install --no-git \
  --with apollo --use-tarballs "$TARBALLS")

EXPECTED=(
  package.json src/index.ts src/worker.ts
  src/journeys/index.ts src/journeys/welcome.ts src/journeys/test-onboarding.ts
  src/journeys/welcome.test.ts
  src/journeys/ai-onboarding.ts
  src/journeys/constants/index.ts
  src/agents/index.ts src/agents/onboarding-concierge.ts
  src/lib/user-context.ts
  src/buckets/index.ts src/buckets/power-users.ts
  src/buckets/qualified-leads.ts src/buckets/qualified-leads.test.ts
  src/webhook-sources/index.ts src/webhook-sources/posthog.ts
  src/destinations/index.ts
  src/workflows/index.ts src/workflows/backfill-example.ts
  src/schema/index.ts scripts/migrate.ts scripts/bootstrap.ts
  drizzle.config.ts migrations/0000_init.sql migrations/meta/_journal.json
  migrations/meta/0000_snapshot.json
  docker-compose.yml railway.toml railway.worker.toml
  Dockerfile .dockerignore scripts/preflight.sh
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
grep -q "\"packageManager\": \"$REPO_PACKAGE_MANAGER\"" "$APPDIR/package.json" \
  || fail "scaffold does not pin root packageManager ($REPO_PACKAGE_MANAGER)"
grep -q 'file:.*hogsend-engine' "$APPDIR/package.json" \
  || fail "tarball file: dep not present in package.json"
# --with apollo must pin the plugin as a DIRECT dependency (an engine-only
# optionalDependency is never linked at the app's top level — the #611 gap).
grep -q '"@hogsend/plugin-apollo": "file:' "$APPDIR/package.json" \
  || fail "--with apollo did not add @hogsend/plugin-apollo to dependencies"
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
# The env-driven first-admin path (STUDIO_ADMIN_EMAIL boot mint) only works if
# the emitted entry point calls the engine's bootstrapAdminFromEnv — this went
# missing once and the documented path silently minted nothing.
grep -q 'bootstrapAdminFromEnv' "$APPDIR/src/index.ts" \
  || fail "emitted src/index.ts does not call bootstrapAdminFromEnv"
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

# --- 3b2. non-pnpm scaffolds are not mislabeled for Corepack --------------
echo "==> [3b2] npm scaffold omits pnpm packageManager"
NPM_DIR="$APP_PARENT/npm-app"
(cd "$APP_PARENT" && node "$CLI" npm-app --pm npm --no-install --no-git \
  --no-skills --use-tarballs "$TARBALLS")
[ -e "$NPM_DIR/package.json" ] || fail "npm scaffold produced no app"
if grep -q '"packageManager"' "$NPM_DIR/package.json"; then
  fail "npm scaffold was incorrectly pinned to pnpm"
fi
echo "    npm scaffold packageManager OK"

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
# Without the PostHog flags, the env must be UNTOUCHED — the step-3 scaffold
# keeps .env.example byte-identical to the template. (Its `--with apollo` is
# env-invisible BY DESIGN: the template already documents APOLLO_API_KEY, so
# the plugin's env append dedupes to a no-op.)
diff -q "$APPDIR/.env.example" "$PKG_DIR/template/env.example" >/dev/null \
  || fail "step-3 scaffold .env.example drifted from template/env.example \
(skipping PostHog + selecting apollo must both be env no-ops)"
echo "    --posthog-key env OK"

# --- 3d. --admin-email/--admin-password/--posthog write the headless env ---
echo "==> [3d] scaffold (--admin-email + --admin-password + --posthog) headless env"
ADMIN_DIR="$APP_PARENT/with-admin"
(cd "$APP_PARENT" && node "$CLI" with-admin --pm pnpm --no-install --no-git \
  --admin-email agent@example.com --admin-password hogsend-agent-pw \
  --posthog --use-tarballs "$TARBALLS")
[ -e "$ADMIN_DIR/.env.example" ] \
  || fail "--admin-email scaffold produced no .env.example"
# Capture-then-grep (see the 3c SIGPIPE note above).
ADMIN_ENV="$(cat "$ADMIN_DIR/.env.example")"
grep -q '^STUDIO_ADMIN_EMAIL=agent@example.com$' <<<"$ADMIN_ENV" \
  || fail "STUDIO_ADMIN_EMAIL not written by --admin-email"
grep -q '^STUDIO_ADMIN_PASSWORD=hogsend-agent-pw$' <<<"$ADMIN_ENV" \
  || fail "STUDIO_ADMIN_PASSWORD not written by --admin-password"
# Intent-only --posthog must write NO PostHog env values.
if grep -q '^POSTHOG_API_KEY=' <<<"$ADMIN_ENV"; then
  fail "intent-only --posthog wrote POSTHOG_API_KEY (must write no env)"
fi
echo "    headless admin env OK"

# --- 3d2. --with is repeatable + comma-separated, and surfaces env blocks ---
echo "==> [3d2] scaffold (--with hogsend,postmark,twilio) deps + env blocks"
WITH_DIR="$APP_PARENT/with-plugins"
(cd "$APP_PARENT" && node "$CLI" with-plugins --pm pnpm --no-install --no-git \
  --no-skills --with hogsend,postmark,twilio --use-tarballs "$TARBALLS")
grep -q '"@hogsend/plugin-hogsend": "file:' "$WITH_DIR/package.json" \
  || fail "--with hogsend did not add @hogsend/plugin-hogsend"
grep -q '"@hogsend/plugin-postmark": "file:' "$WITH_DIR/package.json" \
  || fail "--with postmark,twilio did not add @hogsend/plugin-postmark"
grep -q '"@hogsend/plugin-twilio": "file:' "$WITH_DIR/package.json" \
  || fail "--with postmark,twilio did not add @hogsend/plugin-twilio"
# Unlike apollo, these credentials are not in the template — the scaffold must
# surface their commented blocks (keys only, never a placeholder value).
WITH_ENV="$(cat "$WITH_DIR/.env.example")"
grep -q '^# HOGSEND_EMAIL_TOKEN=$' <<<"$WITH_ENV" \
  || fail "--with hogsend did not surface HOGSEND_EMAIL_TOKEN in .env.example"
grep -q '^# POSTMARK_SERVER_TOKEN=$' <<<"$WITH_ENV" \
  || fail "--with postmark did not surface POSTMARK_SERVER_TOKEN in .env.example"
grep -q '^# TWILIO_ACCOUNT_SID=$' <<<"$WITH_ENV" \
  || fail "--with twilio did not surface TWILIO_ACCOUNT_SID in .env.example"
echo "    --with deps + env blocks OK"

# --- 3e. flag validation failures exit non-zero ----------------------------
echo "==> [3e] invalid headless flag combos are rejected"
expect_reject() {
  local why="$1"; shift
  if (cd "$APP_PARENT" && node "$CLI" "$@" --pm pnpm --no-install --no-git \
    --use-tarballs "$TARBALLS" >/dev/null 2>&1); then
    fail "expected rejection: $why"
  fi
}
expect_reject "--admin-password without --admin-email" \
  bad-1 --admin-password longenough
expect_reject "--posthog with --no-posthog" bad-2 --posthog --no-posthog
expect_reject "short --admin-password (engine min 8)" \
  bad-3 --admin-email a@b.com --admin-password short
expect_reject "malformed --admin-email" bad-4 --admin-email not-an-email
expect_reject "unknown --with id" bad-5 --with nonsense
echo "    flag validation OK"

# --- 4. install -----------------------------------------------------------
# Plain `pnpm install`, NOT --ignore-workspace: the scaffold ships its own
# pnpm-workspace.yaml (settings root: allowBuilds + minimumReleaseAgeExclude,
# packages: []), which BOTH stops pnpm from joining any parent workspace AND
# carries the pnpm 11 build-script approvals. --ignore-workspace would discard
# that settings file and resurrect ERR_PNPM_IGNORED_BUILDS on pnpm >= 11.
echo "==> [4/10] pnpm install (scaffolded app)"
INSTALL_LOG="/tmp/hogsend-verify-install.log"
if ! (cd "$APPDIR" && pnpm install >"$INSTALL_LOG" 2>&1); then
  echo "----- pnpm install output -----" >&2
  tail -40 "$INSTALL_LOG" >&2
  fail "pnpm install failed"
fi
[ -f "$APPDIR/node_modules/@hogsend/engine/src/index.ts" ] \
  || fail "engine raw .ts not present in node_modules (tarball did not carry src)"

# --- 5. check-types -------------------------------------------------------
echo "==> [5/10] pnpm check-types (scaffolded app)"
TYPES_LOG="/tmp/hogsend-verify-check-types.log"
if ! (cd "$APPDIR" && pnpm check-types) >"$TYPES_LOG" 2>&1; then
  cat "$TYPES_LOG" >&2
  diagnose_dependency_types "$TYPES_LOG" "$APPDIR"
  fail "check-types failed"
fi

# --- 6. test --------------------------------------------------------------
echo "==> [6/10] pnpm test (scaffolded journey example)"
(cd "$APPDIR" && pnpm test) || fail "tests failed"

# --- 7. build -------------------------------------------------------------
echo "==> [7/10] pnpm build (scaffolded app)"
(cd "$APPDIR" && pnpm build >/dev/null) || fail "build failed"
[ -f "$APPDIR/dist/index.js" ] || fail "dist/index.js not produced"
[ -f "$APPDIR/dist/worker.js" ] || fail "dist/worker.js not produced"

# --- 7b. opt-in plugins load under plain node -----------------------------
# Reproduce EXACTLY what the engine does at runtime: a dynamic import whose
# specifier is assembled at runtime (invisible to tsc AND the bundler), so it
# resolves from the scaffolded app's own node_modules. MUST be plain `node`,
# not tsx — tsx transpiles node_modules and would have masked the raw-.ts
# runtime entry that shipped #611.
#
# Resolving is NOT enough, and this does not generalize across packages: the
# engine's loader reaches for one EXACT named export per plugin, so a rename
# leaves the import working and the env preset silently dead, and the raw-.ts
# entry that shipped #611 is a per-package packaging mistake. Every opt-in
# plugin the engine loads this way therefore gets its own assertion here.
assert_plugin_loads() {
  local dir="$1" pkg="$2" export_name="$3"
  # An app with no node_modules would fail this for the WRONG reason — or worse,
  # tempt a conditional skip that never runs. Fail loudly instead.
  [ -d "$dir/node_modules" ] \
    || fail "$pkg load assertion needs installed dependencies, but $dir has no node_modules"
  (cd "$dir" && PLUGIN_PKG="$pkg" PLUGIN_EXPORT="$export_name" \
    node --input-type=module -e '
    const [scope, name] = process.env.PLUGIN_PKG.split("/");
    const specifier = [scope, name].join("/");
    const exportName = process.env.PLUGIN_EXPORT;
    const mod = await import(specifier);
    if (typeof mod[exportName] !== "function") {
      console.error(`${specifier} has no ${exportName} function export`);
      process.exit(1);
    }
  ') || fail "$pkg did not load under plain node from $dir"
  echo "    $pkg resolves + exports $export_name (plain node, runtime specifier)"
}

echo "==> [7b] opt-in plugin dynamic imports under plain node"
assert_plugin_loads "$APPDIR" "@hogsend/plugin-apollo" createApolloProvider

# plugin-hogsend is only ever a dependency of the `--with hogsend` scaffold, and
# 3d2 builds that app with --no-install, so install it HERE — after step 4, so
# pnpm's store is already warm from the main app. The free-on-wall-clock
# alternative (adding `hogsend` to the main app's --with set) was rejected: the
# hogsend env block is genuinely APPENDED to .env.example where apollo's dedupes
# against the template, so it would break step 3c's byte-identity check, and
# weakening an existing assertion to make a new one cheap is a bad trade. --prod
# skips the scaffold's dev toolchain (biome/vitest/tsup/drizzle-kit); the opt-in
# plugins are runtime dependencies, which is all this import needs.
echo "    installing the --with hogsend scaffold (runtime deps only)"
WITH_INSTALL_LOG="/tmp/hogsend-verify-with-install.log"
if ! (cd "$WITH_DIR" && pnpm install --prod --ignore-scripts \
  >"$WITH_INSTALL_LOG" 2>&1); then
  echo "----- with-plugins pnpm install output -----" >&2
  tail -40 "$WITH_INSTALL_LOG" >&2
  fail "pnpm install failed for the --with hogsend scaffold"
fi
assert_plugin_loads "$WITH_DIR" "@hogsend/plugin-hogsend" createHogsendEmailProvider

# --- 8. boot smoke --------------------------------------------------------
# The AI-SDK bundling bug ("Dynamic require of X is not supported") throws at
# MODULE EVAL — before any DB/Redis connection — so a build-only smoke misses
# it (this is exactly how engine 0.35.0 shipped a consumer-crashing release).
# We can't assert on exit code: with no .env the app legitimately exits non-zero
# at env-validation, which is itself PROOF the module graph loaded fine. So we
# boot each entry (timeout-bounded) and FAIL only on the telltale module-eval
# signatures — reaching env-validation (or staying up to the timeout) is a PASS.
echo "==> [8/10] boot smoke (node dist/index.js + dist/worker.js)"
for entry in index worker; do
  log="/tmp/hogsend-boot-$entry.log"
  (cd "$APPDIR" && "$TIMEOUT" 8 node "dist/$entry.js" >"$log" 2>&1) || true
  if grep -qiE 'Dynamic require|is not supported|Cannot use import statement|SyntaxError|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM' "$log"; then
    echo "----- boot output ($entry) -----" >&2; cat "$log" >&2
    fail "dist/$entry.js failed at module eval — a CJS dep was bundled into ESM; add it to template/_package.json dependencies so tsup externalizes it"
  fi
  echo "    dist/$entry.js loads clean (no module-eval crash)"
done

# --- 8b. boot smoke with APOLLO_API_KEY set -------------------------------
# The engine's guarded plugin import runs at module eval, gated on the key —
# but only if env validation passes first, so dummy required env is supplied
# (values never leave this harness). "is not installed" is the engine's
# not-installed diagnostic: seeing it when the package IS a dependency of the
# scaffold is precisely the #611 regression. The other loader diagnostics
# ("failed to load", "does not export") are asserted absent too.
echo "==> [8b] boot smoke with APOLLO_API_KEY (plugin preset must load)"
for entry in index worker; do
  log="/tmp/hogsend-boot-apollo-$entry.log"
  (cd "$APPDIR" && "$TIMEOUT" 8 env \
    APOLLO_API_KEY=dummy-apollo-key \
    DATABASE_URL=postgresql://verify:verify@localhost:5434/verify \
    BETTER_AUTH_SECRET=verify-scaffold-dummy-secret-32-chars-long \
    HATCHET_CLIENT_TOKEN=dummy-hatchet-token \
    node "dist/$entry.js" >"$log" 2>&1) || true
  # Guard against a VACUOUS pass: if the dummy env above ever stops satisfying
  # validation, module eval aborts before the plugin loader runs and the greps
  # below prove nothing. Extend the env here if this trips after adding a
  # required env var to the engine.
  if grep -q 'Invalid environment variables' "$log"; then
    echo "----- boot output ($entry) -----" >&2; cat "$log" >&2
    fail "dist/$entry.js failed env validation under the harness dummy env — the plugin-load assertion never ran; add the new required var to this step"
  fi
  if grep -qE 'is not installed|IS installed but failed to load|does not export' "$log"; then
    echo "----- boot output ($entry) -----" >&2; cat "$log" >&2
    fail "dist/$entry.js could not load @hogsend/plugin-apollo at boot — the opt-in plugin is a dependency of the scaffold, so its env preset must resolve"
  fi
  echo "    dist/$entry.js boots without a plugin-load diagnostic"
done

# --- 9. lint --------------------------------------------------------------
echo "==> [9/10] biome check (scaffolded app)"
(cd "$APPDIR" && pnpm exec biome check .) || fail "biome check failed"

# --- 10. cleanup (trap) ---------------------------------------------------
echo "==> [10/10] cleanup /tmp dirs"
echo ""
echo "PASS: scaffold -> install -> check-types -> test -> build -> boot -> lint all green."
