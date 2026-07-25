# PRD 01 — Boot diagnostics are observable over the wire

## Goal

Make a misconfigured-but-running Hogsend deployment distinguishable from a
healthy one **without reading logs** — in BOTH processes. The engine detects
the conditions we care about but surfaces them only as stdout warnings (and in
at least one case — Twilio creds without a sender — not at all, and in another
— PostHog person reads disabled — only as an async `logger.info`); nothing
collects them, so `hogsend doctor` reports `ok` on an instance whose email
provider is a stub and whose Apollo plugin failed to load.

## Locked decisions (inherits DECISIONS.md §3)

- Module-level singleton collector — the plugin loaders record under top-level
  `await`, before any container exists (§3a).
- Deduped by stable `code`, last write wins — `createHogsendClient` runs more
  than once per process (§3b).
- `/v1/health` exposes a **count only**; full text is admin-authenticated (§3c).
- Diagnostics never change health `status` (§3d).
- Worker-process diagnostics ride the Redis worker heartbeat and are merged
  into the API's surfaces, tagged by process (§3g) — an API-only view misses
  the exact process `#611`'s evidence lived on.

## Acceptance criteria (EARS)

1. WHEN a boot diagnostic is recorded twice with the same `code`, the collector
   SHALL hold exactly one entry for that code.
2. WHEN an opt-in plugin is enabled by env but fails to load, the engine SHALL
   record a boot diagnostic in addition to the existing `console.warn`.
3. WHEN no email provider is configured, the container SHALL record a boot
   diagnostic alongside its existing `logger.warn`.
4. WHEN a contact source declares `match` auth with no secret set, the container
   SHALL record a boot diagnostic alongside its existing `logger.warn`.
5. WHEN `GET /v1/health` is requested, the response SHALL include
   `config: { warnings: <number> }` equal to the collector's entry count.
6. WHEN `GET /v1/health` is requested, the response SHALL NOT contain any
   diagnostic `message` or `code` text.
7. WHEN boot diagnostics exist, `GET /v1/health` SHALL still report `status`
   `healthy` if components are up and both schema tracks are in sync.
8. WHEN `GET /v1/admin/config` is requested without admin authentication, the
   system SHALL reject it with the router's standard unauthorized response.
9. WHEN `GET /v1/admin/config` is requested with admin authentication, the
   response SHALL list every recorded diagnostic with its `code` and `message`.
10. WHEN `hogsend doctor` runs against an instance reporting a non-zero warning
    count without an admin key, it SHALL print the count and how to see detail.
11. WHEN `hogsend doctor --admin-key <key>` runs, it SHALL list each diagnostic's
    message.
12. WHEN `hogsend doctor` finds only config warnings and the instance is
    otherwise healthy, its exit code SHALL remain 0 — a warning is advisory.
13. WHEN the SMS env preset detects Twilio credentials with neither `SMS_FROM`
    nor `TWILIO_MESSAGING_SERVICE_SID` set, the engine SHALL warn AND record a
    boot diagnostic (`sms.no-sender`) — today this skip is fully silent and the
    first symptom is `sendSms` throwing at send time.
14. WHEN the PostHog analytics preset resolves with person reads disabled, the
    engine SHALL record a boot diagnostic (`analytics.person-reads-disabled`)
    when the token-manager prime settles.
15. WHEN a boot diagnostic is recorded in the worker process, `GET /v1/health`
    SHALL include it in the merged (union-by-code) warning count and
    `GET /v1/admin/config` SHALL list it tagged with its process.
16. WHEN `hogsend doctor --url <origin>` targets an origin different from the
    configured `HOGSEND_API_URL` and no `--admin-key` flag was passed, doctor
    SHALL NOT transmit any Authorization header.
17. WHEN the `/v1/health` response contains no `config` block or reports
    `config.warnings: 0`, doctor SHALL NOT call `/v1/admin/config`.

## Tasks

### T1 — the collector

Create `packages/engine/src/lib/boot-diagnostics.ts`: a `BootDiagnostic`
(`{ code: string; message: string }`), a module-level `Map<string, BootDiagnostic>`,
`recordBootDiagnostic(d)`, `getBootDiagnostics(): readonly BootDiagnostic[]`, and
a test-only `clearBootDiagnostics()`. Unit tests cover dedupe-by-code,
last-write-wins, insertion order, and that reading returns a copy the caller
cannot mutate.

_Boundary:_ `packages/engine` · _Depends:_ —

### T2 — record at every detected-misconfiguration site

Thread `recordBootDiagnostic` into every site where the engine DETECTS a
misconfiguration — not only the sites that already warn — WITHOUT removing or
changing a single existing log line (the log is the operator's first channel;
this only adds a second):

- **Plugin load failures — record INSIDE `lib/load-optional-plugin.ts`, not in
  the from-env call sites' `onFailure` hooks.** The hooks run once per process
  at module scope, gated on env at import time, and the workspace links the
  real plugins (`optionalDependencies: workspace:^`) — so the failure path
  cannot be provoked in-workspace and hook-side recording has no viable test.
  The loader is deliberately testable against an injected specifier: record
  unconditionally on failure with a code derived from the specifier + outcome
  (e.g. `plugin.load-failed:@hogsend/plugin-apollo`), keep `onFailure` for the
  `console.warn`, and extend the existing injected-specifier unit tests to
  assert recording for all three outcomes (not-installed / load-failed /
  missing-export). That is the only mutation-verifiable test for AC2.
- `container.ts` — no-email-provider (~1046), native-tracking-not-disable-able
  (~1058), contact-source-without-secret (~1595), excluded-opt-out-list (~787),
  ignored `crm.{stages,stageMaps}` (~927).
- `lib/sms-providers-from-env.ts` — the creds-without-sender skip (Twilio creds
  set, neither `SMS_FROM` nor `TWILIO_MESSAGING_SERVICE_SID`): today detected
  and deliberately skipped with NO warn on any path, leaving the throwing SMS
  stub installed. ADD the missing warn and record `sms.no-sender`. (Audited:
  the Resend/Postmark/Apollo presets gate only on the credential itself — this
  is the sole silent-skip instance.)
- `lib/analytics-providers-from-env.ts` (~72–85) — the person-reads-disabled
  condition, surfaced today only as a `logger.info` fired asynchronously after
  `tokenManager.prime()` settles (plus its sync sibling in `container.ts`
  ~1452): record `analytics.person-reads-disabled`. Late recording is safe —
  the deduped process-global collector is read per-request by `/v1/health`.

Each gets a stable, namespaced `code`. A per-source code must stay unique across
sources (e.g. `contact-source.no-secret:<id>`) so two unsecured sources produce
two diagnostics, not one.

Engine tests assert a diagnostic is recorded for the no-email-provider,
unsecured-contact-source, and sms-no-sender paths, plus the three loader
outcomes via the injected specifier. Count-asserting tests must account for
`clearBootDiagnostics()` permanently discarding module-scope loader entries for
the rest of the process (module scope never re-evaluates) — assert specific
codes or deltas, never absolute collector counts.

_Boundary:_ `packages/engine` · _Depends:_ T1

### T3 — surface on `/v1/health`

Add `config: { warnings: z.number() }` to `healthResponseSchema` and populate it
from `getBootDiagnostics().length` (T7 extends this to the API+worker merged
count). It must not participate in the `status` computation. Test: warnings
present → `config.warnings` matches, `status` is still `healthy`, and the
serialized body contains no diagnostic message text.

Verified no-break: no test in the repo asserts the exact `/v1/health` body
shape (all are field-presence/`toContain`; zero snapshots; no OpenAPI diff),
and the CLI's `HealthResponse` is a declared subset — the additive `config`
field breaks no existing consumer. Do not hunt for a snapshot to update.

_Boundary:_ `packages/engine` · _Depends:_ T1

### T4 — admin detail route

Add `GET /v1/admin/config` to the admin router returning
`{ warnings: BootDiagnostic[] }`, inheriting the admin router's existing
`requireAdmin` guard (do not hand-roll auth). Test the unauthorized rejection and
the authorized payload.

_Boundary:_ `packages/engine` · _Depends:_ T1

### T5 — `hogsend doctor` renders it

Extend the CLI's `HealthResponse` type with `config` and render a `Config`
section. The `/v1/admin/config` detail fetch is DOUBLE-GATED — the CLI resolves
the admin key from process env and the cwd `.env` as a silent fallback
(`lib/config.ts:154-159`), so an unguarded fetch would transmit a full-admin
Bearer token (possibly a prod key) to an arbitrary `--url` origin:

1. Only call `/v1/admin/config` when the `/v1/health` response actually
   contains a `config` block AND `config.warnings > 0` — an older engine has no
   `config` block, and sending the key toward a guaranteed 404 still puts it on
   the wire.
2. Only use an env/`.env`-derived admin key when the base URL was NOT
   explicitly overridden via `--url` — mirror the existing `urlExplicit` rule
   (`lib/config.ts:17-23`). An explicit `--admin-key` flag always authorizes
   the send.

Update the `--admin-key` usage text (currently "Unused by doctor"). Warnings
must not change the verdict or the exit code. `--json` output gains the warning
count and, when fetched, the detail array. Test AC16: `--url` to a different
origin with an admin key present only in env → no Authorization header sent.

_Boundary:_ `packages/cli` · _Depends:_ T3, T4

### T6 — docs

Document the diagnostics surface where the health/doctor contract is already
described, including that `config.warnings` is the merged API+worker view. No
new summary doc.

_Boundary:_ docs · _Depends:_ T5, T7

### T7 — worker diagnostics reach `/v1/health`

The collector is per-process memory and only the API process serves HTTP
(`worker.ts` starts no server; `railway.worker.toml` has no healthcheck), and
Railway env is per-service — a worker-only credential (`TWILIO_*`,
`APOLLO_API_KEY`; sends execute in the worker) records into a collector no
surface can read, which is exactly `#611`'s shape. Per §3g: have the worker
publish its diagnostics (codes + messages) as a JSON payload on the existing
Redis worker-heartbeat channel (`lib/worker-heartbeat.ts`; `routes/health.ts`
already reads it under a deadline). `/v1/health` reports the union-by-code
count of API + worker entries in `config.warnings`; `/v1/admin/config` lists
every entry tagged by process (`api` | `worker`). Redis-down or stale
heartbeat degrades to the API-only count — never an error. Test: seed a
diagnostic into the heartbeat payload, assert the merged count and the tagged
detail; mutation-verify per DECISIONS §5.

_Boundary:_ `packages/engine` · _Depends:_ T1, T3, T4

## Seams

None. Every surface is in-repo and testable without external credentials.

## Done when

All 17 criteria hold, gates green per DECISIONS §4, and the T2/T3/T7 regression
tests are mutation-verified per DECISIONS §5.

## Implementation Notes

Shipped complete (T1–T7). Collector is a process-global `Map` (module-scope
loaders record before any container exists); recording sites preserve every
existing log line. `/v1/health` reports a union-by-code count of API + worker
diagnostics (worker leg rides the Redis heartbeat, now a JSON payload on the
same key/TTL; legacy bare-timestamp payloads still read as alive); detail is
admin-only on `/v1/admin/config`. `hogsend doctor` renders the count always and
the detail behind a double gate. T6 docs live in `apps/docs/content/docs/cli/
doctor.mdx`.

Post-review fix (`2bac4a0a`): the doctor detail-fetch gate originally keyed only
on an explicit `--url`; a cwd `.env`'s `HOGSEND_API_URL` could redirect an
ambient admin key to an attacker origin. Now gated on url/key source provenance
(a `.env`-derived origin is treated as untrusted unless the key came from the
same `.env`). Also corrected the `sms.no-sender` message to not over-claim an
inert stub when a consumer supplies their own SMS provider.
