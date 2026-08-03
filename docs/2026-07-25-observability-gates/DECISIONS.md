# DECISIONS — Observability & release gates (0.55.0 post-mortem follow-up)

Locked global choices every PRD in this wave inherits. Settled — do not re-litigate.

## 1. Why this wave exists

`#611` shipped for three releases while every signal stayed green: `/v1/health`
reported `healthy`, the schema was in sync, and the only evidence was a single
misleading log line on a worker nobody was tailing. Two structural gaps let that
happen:

1. **Boot-time config problems are invisible over the wire.** The engine
   detects them and usually `logger.warn`s (no email provider, an opt-in plugin
   that failed to load, an unauthenticated contact source, native-tracking it
   can't disable) — and in at least one case (Twilio creds set with neither
   `SMS_FROM` nor `TWILIO_MESSAGING_SERVICE_SID`) it detects and silently
   skips with no warn at all. Warnings exist only in stdout, and only in the
   process that emitted them — the worker has no HTTP surface. Nothing an
   operator or `hogsend doctor` can query reports them, so an inert deployment
   is indistinguishable from a healthy one.
2. **Nothing asserts a published package is actually loadable.** `release-doctor`
   is a static invariant checker (its "loadable dist" check covers only engine
   `optionalDependencies`); the only real load proof lives inside the heavy,
   conditionally-skipped `create-hogsend verify` smoke, and only for Apollo.
   Note `#611`'s actual mode: the declared entry WAS inside the tarball — a raw
   `./src/index.ts` npm packed happily and Node refused to load under
   `node_modules`. Presence-in-tarball is necessary but NOT sufficient; the
   gate must prove the packed entry actually loads.

## 2. Product definition

Two independent improvements, no shared code:

- **Boot diagnostics** — a process-global, deduped collector the engine records
  into at boot; worker-process entries cross to the API via the Redis worker
  heartbeat (§3g); surfaced as a count on the unauthenticated `/v1/health` and
  in full detail on an admin-authenticated route; rendered by `hogsend doctor`.
- **Release gates** — a static `catch`-swallowing check inside `release-doctor`
  (structured `hogsend:allow-swallow` opt-out only, §3f), plus a new
  `pnpm verify-tarballs` script that packs each publishable package, asserts
  every declared entry (`exports["."]` string leaves, `main`, every `bin`
  target, declared `types`) is inside the tarball, and — for dist-resident
  runtime entries — installs the real tarball into a temp dir and `import()`s
  the entry under plain node. Presence alone would have passed `#611` (§1.2).

## 3. Locked architecture decisions

### 3a. The collector is process-global, not container-scoped

The failing case that motivates this feature — the opt-in plugin loaders in
`lib/{enrichment,email,sms}-providers-from-env.ts` — records its diagnostic at
**module scope, under top-level `await`**, before any container exists. A
collector threaded through `createHogsendClient` structurally cannot see it.

Therefore: a module-level singleton in
`packages/engine/src/lib/boot-diagnostics.ts`. Boot diagnostics *are*
process-global state; modelling them otherwise loses the case we care about.

### 3b. Records are deduped by a stable `code`

`createHogsendClient` is called more than once per process (API + worker in dev,
repeatedly across a test file). A plain append would grow without bound and
report the same problem N times. The collector is a `Map` keyed by a stable
machine-readable `code` (`email.no-provider`, `plugin.load-failed`, …); the last
write for a code wins. Re-recording is therefore idempotent.

### 3c. `/v1/health` exposes a COUNT, never the messages

`/v1/health` is unauthenticated (`hogsend doctor` depends on that, and Railway
probes it). The warning text names unset env vars, unauthenticated webhook
sources and absent secrets — that is deployment reconnaissance and must not be
public.

Split:

- `GET /v1/health` → `config: { warnings: <number> }`. A count is enough to make
  "silent-inert" observable and leaks nothing.
- `GET /v1/admin/config` (admin-authenticated) → the full diagnostic array.

`hogsend doctor` already accepts `--admin-key` and currently documents it as
unused. It becomes used: without a key doctor prints the count and how to see
detail; with one it lists the diagnostics.

### 3d. Warnings never change `status`

`status` stays `healthy | degraded | migration_pending`. A config warning is not
a liveness failure and must not fail Railway's healthcheck — that would convert
an advisory into an outage. Same rule the existing `activity` block follows.

### 3e. `release-doctor` stays static; packing gets its own script

`release-doctor` runs in ci.yml's Release-integrity job **without a preceding
build**, and in release.yml **after** `turbo run build`. A packing assertion
inside `release-doctor` would therefore be red on every PR.

So the packing gate is a separate `scripts/verify-tarball-entries.mjs`
(`pnpm verify-tarballs`) that builds the dist-shipping packages itself before
packing, via `pnpm exec turbo run build --filter=<derived pkgs>
--concurrency=2` — turbo, not `pnpm --filter build`, because the pnpm form
(the pack-tarballs.sh precedent) never consults the Turbo cache. Do not claim a
cache hit: ci.yml's Release-integrity job runs in parallel with the quality
job, so packages the PR touched are cold — the honest cost is ~1–2 min cold
builds plus ~20–30s of packs.

Wiring: **unconditional in ci.yml's Release-integrity job** — never behind a
change-detection skip, which is how the current scaffold smoke can be silently
absent. In release.yml it is guarded `if: steps.phase.outputs.publish ==
'true'` and placed AFTER the build steps. This amends the original
"unconditionally in both workflows" wording: Phase A (any main push carrying
changesets, the common case, deliberately kept to ~9s of file ops) publishes
nothing and the same SHA already ran the gate in ci.yml, so an unguarded step
would re-add minutes to every main push while gating nothing. A publish-phase
guard is not change detection — every path that can reach npm still runs the
gate.

### 3f. The `catch` gate is calibrated before it is enforced

A blanket "no silent catch" rule across a comment-dense codebase can produce a
hundred offenders and turn into mass annotation churn. The scanner is written
first and its offender count REPORTED before any source is touched. If the
initial rule yields a large list, tighten the rule — do not annotate the repo to
fit it.

The non-negotiable core is any `catch` that discards its error binding — an
empty `catch {}` / `catch (e) {}` body, AND a non-empty body that never uses
the error. This amends the original empty-body-only core: the three catches
that shipped `#611` were non-empty (`createPostmarkProvider = null;`) and
carried confident explanatory comments that were WRONG ("the opt-in package
isn't installed" for every failure mode) — an empty-body rule passes them
verbatim. For the same reason a plain explanatory comment is NOT an exemption.
The only opt-out is a structured, greppable marker
(`// hogsend:allow-swallow <reason>`) so every exemption is a deliberate,
reviewable annotation. Anything wider than the core is earned by a small
offender count.

### 3g. Worker diagnostics cross the process boundary via the Redis heartbeat

The collector (§3a) is per-OS-process memory, but only the API process serves
HTTP: `worker.ts` starts no server and `railway.worker.toml` has no
healthcheck. Railway env is per-service, and the opt-in credentials
(`TWILIO_*`, `APOLLO_API_KEY`) are consumed by worker-side execution, so a
worker-only misconfiguration records into a collector no surface can read —
`#611`'s only evidence was a log line on exactly that process. An API-only
collector would leave the wave's motivating case invisible.

Decision: the worker publishes its diagnostics (codes + messages) as a JSON
payload on the existing Redis worker-heartbeat channel
(`lib/worker-heartbeat.ts` — built for precisely this process boundary;
`routes/health.ts` already reads it under a deadline). `/v1/health` reports
the union-by-code count of API + worker entries in `config.warnings`;
`/v1/admin/config` lists every entry tagged by process (`api` | `worker`).

## 4. Quality gates (verbatim)

```bash
pnpm exec turbo run check-types --concurrency=2 --force
pnpm exec turbo run lint --concurrency=2
pnpm exec turbo run test --concurrency=2 --force
pnpm exec turbo run build --concurrency=2
pnpm release-doctor
```

`--force` is mandatory whenever new/untracked files are involved: Turbo hashes
tracked content, so a new file yields a cached green that proves nothing
(`reference_vacuous-green-tests`).

Engine tests are `node:test` via `tsx --test 'src/**/*.test.ts'` (glob MUST stay
quoted). `packages/core`, the plugins and `apps/api` are vitest.

Never target port 5434 for local test runs; export `HOGSEND_TEST_DATABASE_URL`
rather than editing any test default.

## 5. Verification standard

A green test is not evidence. Every regression test in this wave guards a bug
that already shipped, so each one is **mutation-tested**: break the fix
deliberately, watch the test go red, restore, confirm green. A test that stays
green under mutation is a wrong test and must be rewritten.

Read output for evidence that work happened — test counts moving, `0 cached`,
a named assertion — not a bare PASS.

## 6. Conventions

- Conventional commits, one per task. No AI/vendor mention, no `Co-Authored-By`.
- `pnpm add <pkg>@latest` over hand-edited versions.
- No new summary markdown. Only `BACKLOG.md` markers and each PRD's
  `## Implementation Notes` are edited during BUILD.

## 7. Publish mode

`branch + PR` — commit locally on the worktree branch, then push and open one PR
covering both PRDs. No release/publish in this wave; the changeset rides the next
train.
