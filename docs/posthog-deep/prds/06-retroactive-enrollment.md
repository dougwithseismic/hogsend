# PRD 06 — `retroactive-enrollment`

**Depends on:** 00 (`posthog-identity-map` — the person↔contact resolver this pulls
through). **Status:** `[ ]`

## Goal

`hogsend backfill --since 90d [--send] [--max-age <duration>]`: pull historical PostHog
events for a window, resolve each to a Hogsend contact, and feed them through the real
ingest/journey-enrollment pipeline with their **original** timestamps — so a journey
authored today can retroactively enroll people based on what they already did, not just
what they do from now on. **Dry-run by default.** Real sends require the explicit
`--send` flag. An age cutoff prevents a 90-day replay from emailing someone about
something that is no longer true (a trial that ended in March).

## Why this is the hardest PRD in the stack

Recon (Part 2) found three separate, independently-serious gaps, all of which this PRD
must design around from the start, not retrofit after a naive implementation ships:

1. **`ingestEvent` accepts a historical timestamp — but most of the system silently
   ignores it for anything time-window-relative.**
2. **No dry-run/simulate mode exists anywhere in this codebase.** It must be built here,
   for the first time, specifically for this feature.
3. **The exactly-once replay-safety machinery in CLAUDE.md is keyed on the Hatchet run
   id — and a backfill run is, definitionally, a brand-new run.** Its own idempotency
   discriminant does not exist yet and must be designed in from line one.

## Locked decisions

### D1 — Historical timestamps DO thread through storage, but time-relative GATES do not

**Verified**, not inferred: `IngestEvent.occurredAt?: Date | string`
(`packages/engine/src/lib/ingestion.ts:100-105`) is accepted and, when set, stamps
`user_events.occurred_at` (`ingestion.ts:368-370`, then spread into both insert paths at
lines 419 and 442) **instead of** the column's `defaultNow()`
(`packages/db/src/schema/user-events.ts:38-40`). So far so good — replayed events land
with correct historical timestamps in the row that persists.

**But every time-relative gate in the enrollment path computes against the REAL wall
clock at evaluation time, never against the replayed event's `occurredAt`:**

- `evaluateEventCondition`'s `within` cutoff is
  `new Date(Date.now() - durationToMs(condition.within))`
  (`packages/core/src/conditions/event.ts:19-24`) — literal `Date.now()`. A bucket/journey
  criterion "event X within 7 days" evaluated **during** a backfill run of 90-day-old
  events compares those events against (today − 7 days), not (event's own historical day
  − 7 days). This is actually the CORRECT semantic for "is this still true" — it is not a
  bug to fix, it is a constraint this PRD's consumers must understand: **a backfill run
  cannot reconstruct "what the system would have decided on day X"; it can only decide
  "given these historical facts, what does today's system decide right now."**
- `checkEntryLimit`'s `once_per_period` gate
  (`packages/engine/src/lib/enrollment-guards.ts:26-38`) computes
  `cutoff = new Date(Date.now() - periodMs)` (real wall clock, line 27) and compares
  against `journeyStates.createdAt` (line 33/37) — **`createdAt` is the row's REAL INSERT
  instant**, not derivable from a replayed `occurredAt`. A 90-day backfill executed in one
  hour creates 90 days' worth of `journeyStates` rows all with `createdAt` inside that one
  hour. To every `once_per_period` gate, **that looks like 90 days of enrollments arriving
  within a single hour** — the cooldown will suppress almost everything after the first
  hit, which is very likely NOT the intended "would have re-enrolled every 30 days over
  90 days" outcome.
- The bucket-level twin (`shouldEmitJoin`'s `once_per_period` arm,
  `packages/engine/src/buckets/check-membership.ts:492-517`) has the identical shape:
  `Date.now() - prior.leftAt.getTime()`, and `leftAt` is a real DB write instant unless a
  caller manually overrides it (nothing does today).

**Chosen handling** [PROPOSED]: this PRD does **not** attempt virtual-clock backfill
(DECISIONS §3.3 rules that out explicitly — enormous blast radius against the
replay-safety laws, `ctx.sleep` cannot be fast-forwarded safely). Instead:

- **Historical event storage is honest** (`occurredAt` threads through, `within`-windowed
  criteria correctly see "is this still true as of today" — which is the right semantic
  for "should this person be in this bucket/journey NOW given history").
- **`once`/`once_per_period` entry-limit gates are NOT bypassed or specially handled for
  backfilled enrollments.** They run for real, against the real clock, exactly as a live
  enrollment would. The practical consequence — a backfill executed in a tight time
  window will look, to a `once_per_period` journey, like a burst of near-simultaneous
  candidates, and only the ones that clear the real gate at the real moment they're
  processed will enroll — is treated as a **known, documented, accepted limitation**, not
  a bug this PRD fixes. Fixing it (e.g. backdating `journeyStates.createdAt`) would mean
  writing fabricated history into a column every other part of the system trusts as "when
  this actually happened," which is a much larger and riskier change than this PRD's
  scope justifies for a one-off backfill tool. **Document this loudly in the CLI's own
  output** (see AC 8) rather than pretend the tool doesn't have this constraint.
- **The one thing this PRD DOES control deliberately: enrollment throughput pacing.**
  Processing historical events in strict chronological `occurredAt` order, with a
  configurable minimum spacing between `journeyStates`-creating enrollments per journey
  (not per user — this is a system-wide pacing knob, distinct from any per-user gate),
  gives operators a lever to make `once_per_period` behave closer to its intended shape
  without touching the gate itself. [PROPOSED, not required for MVP — flagged as a task,
  not a hard AC, since it's a mitigation for a documented limitation rather than a fix.]

### D2 — Dry-run must be built from scratch; here is exactly what it suppresses

**Verified, thorough negative search**: no `dryrun`/`dry_run`/`dry-run`/`simulate` pattern
exists anywhere in `packages/engine/src`, `packages/core/src`, or `packages/db/src` that
computes side effects without performing them. The only "dry-run" in the repo is Journey
Blueprint graph **validation** (`routes/admin/blueprints.ts:100,211,311` — schema/registry
linting, not execution simulation) — unrelated prior art, not reusable here.

`ingestEvent`'s 14 steps (full trace: `ingestion.ts:281-817`), and this PRD's dry-run
disposition for each:

| # | Step | Dry-run disposition |
|---|------|----------------------|
| 1 | Identity resolve | **RUN FOR REAL, but FIND-ONLY.** A dry-run still needs to know who would be enrolled, so resolution runs — but through PRD 00's `lookupPostHogPerson`, not `resolvePostHogPerson`/`resolveOrCreateContact` (DECISIONS §2.3 names the dry-run as a find-only consumer). The earlier wording here said contact creation was acceptable because "creation is not a send"; that is superseded. A dry-run that mints contacts writes rows AC 1 promises it will not write, and mass-mints them keyed on PostHog distinct_ids over a 90-day window. Unresolvable persons are **reported as unresolved with a count** — which is a more honest dry-run report than a fabricated resolution, since it tells the operator exactly how many people a real run would have to create. |
| 2 | `occurredAt` coercion | RUN FOR REAL (pure). |
| 3 | Money normalization | RUN FOR REAL (pure, no side effect). |
| 4 | `user_events` insert + idempotency dedup | **SUPPRESS in dry-run** — a dry-run must not pollute `user_events` with rows a real run would then dedupe against or double-count. [PROPOSED] Dry-run computes the row it WOULD insert (including the idempotency key, per D3) and checks for a pre-existing conflict via a `SELECT` instead of an `INSERT ... ON CONFLICT`, so the report is accurate about what a real run would skip. |
| 5 | Analytics identity merge fan-out (`mergeAnalyticsIdentities`) | **SUPPRESS** — fires a real PostHog `alias()` call; not reversible, not something a dry-run should do. |
| 6 | Event mirror `capture()` | **SUPPRESS** — same reasoning; also explicitly excluded for `source==="posthog"` in the real path already (`ingestion.ts:492`), and this backfill's events ARE `source: "posthog"` by construction, so in practice step 6 already no-ops for this feature's real runs too — worth confirming as a test, not assuming. |
| 7 | Group association | **SUPPRESS** in dry-run (DB write); RUN for real sends. |
| 8 | Serializable-properties projection | RUN FOR REAL (pure). |
| 9 | Hatchet push + `checkExits` | **SUPPRESS Hatchet push entirely in dry-run** (this is THE side effect — it is what enrolls journeys and would trigger a real send). [PROPOSED] Dry-run instead evaluates, in-process, exactly what `ingestEvent`'s push would have routed to: walk `registry.getByTriggerEvent(event.event)` (mirroring what Hatchet's own routing does) and run the SAME enrollment guards journeys check before `run()` executes (`meta.enabled` → `evaluateTriggerConditions` → `checkEntryLimit` → `checkEmailPreferences`, per CLAUDE.md's documented order) to produce a "would enroll / would skip, because X" report per candidate journey, WITHOUT creating a `journeyStates` row or invoking `run()`. `checkExits` is read-only against `journeyStates` (no mutation until `statesToExit.length > 0`, `ingestion.ts:901`) — **RUN the read for real** in dry-run (informational: "this historical event would also have exited journey Y"), but suppress the mutation/cancel side effects (`ingestion.ts:901-936`). |
| 10 | Blueprint dispatch | **SUPPRESS** the actual `hatchet.events.push(BLUEPRINT_RUN_EVENT, ...)` (`ingestion.ts:261`); optionally report which blueprints WOULD match (their `triggerEvent`+`triggerWhere`), mirroring the journey-report above. |
| 11 | Conversion-point evaluation + ad-platform dispatch + attribution credits | **SUPPRESS all writes** (conversion row, dispatch enqueue, attribution ledger) in dry-run; this is squarely "would this have counted as a conversion" territory that a dry-run report should surface but never commit. |
| 12 | Funnel stage transitions + funnel progress projection | **SUPPRESS writes**, same reasoning as 11. |
| 13 | Real-time bucket membership re-evaluation (`checkBucketMembership`) | **SUPPRESS the mutation/emission**, but the criteria EVALUATION itself (would this historical event flip membership) is exactly what a cohort-adjacent backfill report wants surfaced. [PROPOSED] `checkBucketMembership` would need its own dry-run parameter threaded through, OR this PRD reimplements a read-only "would transition" check against the same registry indexes rather than modifying the shared function's contract for every other caller. Recommend the latter (smaller blast radius) unless the reviewer prefers threading a flag through the shared function. |
| 14 | Final log + return | RUN FOR REAL. |

**`--send` flips steps 5, 6, 7, 9 (Hatchet push), 10, 11, 12, 13 from suppressed to live**
— i.e. `--send` is not "skip the dry-run report," it is "actually run the real
`ingestEvent` pipeline for real, per-event, exactly as the existing
`POST /v1/admin/events/replay` route does" (see D4 below for why that route is close but
not sufficient prior art).

### D3 — An explicit backfill-job idempotency discriminant, designed in from the start

**Per CLAUDE.md's replay-safety law**: journey sends/triggers are auto-keyed by "the
replay-stable Hatchet run id + the nearest authored wait/checkpoint label +
templateKey/event." **A backfill run is, by definition, a NEW Hatchet run** — it is not a
replay of a prior run, it is a fresh enrollment attempt for historical facts. The
exactly-once machinery that protects against a worker crash mid-journey does **not**
protect against **running the same backfill twice** (operator error, a retried CLI
invocation, a crashed backfill task re-enqueued from scratch). **This is a real, distinct
double-send risk this PRD must close, and it cannot borrow the existing run-id-keyed
mechanism to do it** — a second backfill invocation gets a second, legitimately-different
run id, and CLAUDE.md is explicit that "a distinct new run is a legitimate re-enrollment."

**Chosen handling** [PROPOSED]: mint a **backfill-scoped idempotency key** per (source
event, target contact) pair, independent of any Hatchet run id, and thread it as
`IngestEvent.idempotencyKey` (`ingestion.ts:99`, the SAME field the `user_events` unique
index already dedupes on — `user_events_idempotency_key_idx`,
`packages/db/src/schema/user-events.ts:63`). Shape:
`` `backfill:${backfillJobId}:${sourceEventId}` `` where `sourceEventId` is PostHog's own
event `uuid` (already read and stamped as `_posthogEventId` by the EXISTING webhook source,
`apps/api/src/webhook-sources/posthog.ts:59-61` — reuse that convention, don't invent a
second one) and `backfillJobId` is this task's own `import_jobs.id`.

**RESOLVED — the key is SCOPE-INDEPENDENT, and it is not backfill-specific.**
Decision taken 2026-07-27; `backfillJobId` is NOT part of the key.

The key is `` `posthog:${sourceEventId}` `` where `sourceEventId` is PostHog's own event
`uuid`. Rationale:

1. **The overlap case is the common case, not the edge case.** "I ran `--since 90d` last
   week, I'm running `--since 30d` today" must not re-deliver 30 days of messages. A
   job-scoped key fails exactly this, and it fails it silently and expensively.
2. **A PostHog event uuid is already globally unique**, so no journey/scope discriminant is
   needed to avoid collisions. Nothing else is required to make the key safe.
3. **Deduping at the EVENT layer is the correct layer.** The key threads into
   `user_events.idempotencyKey`, and a dedup hit short-circuits `ingestEvent` at
   `ingestion.ts:426-428` **before any side effect**, so no journey fires and no send
   happens. That is precisely the desired semantics for "this historical fact has already
   been replayed", and it needs no new machinery.
4. **It closes the real-time/backfill overlap** (AC referenced at line 227) as a
   consequence rather than as a separate mechanism.

**Consequence — the real-time webhook path must adopt the same key.** For backfill and
real-time to dedupe against each other, the existing PostHog webhook source must also set
`idempotencyKey: \`posthog:${uuid}\`` rather than leaving it null. It already reads the
event uuid and stamps it as `_posthogEventId`
(`apps/api/src/webhook-sources/posthog.ts:59-61`) but stamps **no `idempotencyKey`**, so
this is a small change at a known site — **owned explicitly by T06.0**, and it must be
applied to BOTH the dogfood consumer and the `packages/create-hogsend/template/` copy.
**This is additive and needs no migration**: Postgres treats NULL as distinct in a
unique index (`user_events_idempotency_key_idx`,
`packages/db/src/schema/user-events.ts:63`), so existing null-keyed rows are unaffected and
simply never participate in dedup. New rows gain the key going forward.

Note the honest limitation this accepts: an event ingested by the real-time loop **before**
this change ships has a null key and will therefore not dedupe against a later backfill
covering that period. Document it, and make the `--since` age-cutoff default conservative
enough that this is rarely reached in practice.

### D4 — Existing prior art is close but insufficient; do not reuse verbatim

Two existing admin routes are directly relevant and were found during recon, but neither
is a substitute for this PRD:

- **`POST /v1/admin/events/replay`** (`packages/engine/src/routes/admin/bulk.ts:116-160,
  375-455`) replays ALREADY-STORED `user_events` rows back through `ingestEvent`. Close
  in shape to what a "dry-run/live" backfill needs — but **it has no dry-run mode, no age
  cutoff, and (verified, `bulk.ts:430-445`) it does NOT pass `occurredAt` through to the
  re-ingest call, so even this existing feature stamps the CURRENT time on replay,
  silently discarding the original event's timestamp.** [ASIDE, not a task in this PRD]
  This looks like a latent, independent gap in shipped code — worth its own follow-up
  ticket — but fixing `bulk.ts`'s replay route is out of scope here; this PRD's new task
  must NOT copy that omission.
- **`POST /v1/admin/journeys/{id}/enroll/batch`** (`bulk.ts:197-246, 507-556`) pushes a
  journey's own `trigger.event` through `ingestEvent` for an arbitrary user list. Useful
  precedent for "how does this codebase already do bulk enrollment," but it enrolls
  against a single named journey by a caller-supplied user list — this PRD needs to pull
  a historical **event stream from PostHog** and let normal trigger-matching decide which
  journeys fire, for potentially many journeys and many users, which is a different shape
  of problem (a producer of events, not a consumer of a fixed user list).

### D5 — Age cutoff is mandatory, not advisory

`--max-age <duration>` (default: unset = no cutoff beyond `--since`, but the CLI SHALL
refuse to run without EITHER `--max-age` or an explicit `--i-understand-no-max-age`
override flag — see AC 6) drops any pulled PostHog event whose `occurredAt` is older than
`now - maxAge`, **before** it reaches `ingestEvent` at all. This is a pre-filter, not a
`within`-window bucket criterion — it protects against the literal example in the brief
("a trial that ended in March") independent of whether any journey/bucket in scope
happens to have its own `within` guard.

## Acceptance criteria (EARS)

1. WHEN `hogsend backfill --since <duration>` is run without `--send`, the system SHALL
   perform a full dry-run: pulling historical PostHog events, resolving identity **through
   the find-only `lookupPostHogPerson`** (creating no contacts, reporting unresolvable
   persons as a count), and reporting per-event which journeys/buckets/conversions/funnels WOULD have
   fired and why, WITHOUT writing `user_events`, WITHOUT pushing to Hatchet, WITHOUT
   sending any email/SMS/connector action, and WITHOUT mutating `bucket_memberships`,
   `journey_states`, or `contacts`.
2. WHEN `--send` is passed, the system SHALL perform the same pull and identity
   resolution, then run each qualifying event through the REAL `ingestEvent` pipeline
   with `occurredAt` set to the event's original PostHog timestamp.
3. WHEN the same backfill job is re-run (same `import_jobs.id`) with `--send`, the system
   SHALL NOT double-send: the idempotency key (D3) SHALL make every re-processed event a
   no-op via the existing `user_events` unique-index dedup.
4. WHEN `--max-age` is set, the system SHALL drop, before ingestion, any pulled event
   older than `now - maxAge`, and SHALL report the count of dropped events.
5. WHEN `--max-age` is NOT set and `--i-understand-no-max-age` is NOT passed, the system
   SHALL refuse to run and SHALL explain why (the "mailing someone about a trial that
   ended in March" failure mode).
6. WHEN a pull is interrupted (rate limit, crash, restart), the system SHALL resume from
   a persisted cursor in `import_jobs` rather than restarting from `--since` and
   re-processing already-handled events from scratch.
7. WHEN the CLI reports dry-run results, the system SHALL explicitly state, in its own
   output, that `once`/`once_per_period` entry-limit gates evaluate against the REAL
   current time and the backfill's real processing order/speed — NOT against the
   historical `occurredAt` values — so an operator is not misled into thinking a dry-run
   report reflects "what would have happened over 90 real days."
8. WHEN no PostHog credential is configured, `hogsend backfill` SHALL fail closed with a
   clear, actionable error (mirroring the existing `409 no_posthog_credential` pattern,
   DECISIONS §2.8) rather than a confusing downstream failure.
9. WHEN the pulled PostHog events include ones already present in `user_events` **and
   ingested at or after T06.0 shipped**, the system SHALL NOT double-ingest them — the same
   `posthog:<eventUuid>` key (D3) SHALL cover the overlap between real-time and backfilled
   coverage of the same historical window.
9a. WHEN an event was ingested by the real-time webhook **before** T06.0 shipped, its
   `user_events.idempotencyKey` is permanently NULL and Postgres treats NULLs as distinct
   in `user_events_idempotency_key_idx` — so it CANNOT dedupe against a later backfill.
   The overlap guarantee in AC 9 holds only **forward of T06.0**. The CLI SHALL state this
   limitation in its own output whenever `--since` reaches back past the operator-recorded
   cutover, rather than implying blanket overlap safety.
9b. WHEN the real-time PostHog webhook source transforms an event carrying a `uuid`, it
   SHALL stamp `idempotencyKey: "posthog:<uuid>"` on the resulting `IngestEvent`. Today it
   stamps only `eventProperties._posthogEventId` and leaves the key null
   (`apps/api/src/webhook-sources/posthog.ts:44-72`, verified) — so AC 9 is unsatisfiable
   until T06.0 lands.

## Tasks

### T06.0 — Stamp the idempotency key on the REAL-TIME path
_Boundary:_ `apps/api/src/webhook-sources/posthog.ts` **AND**
`packages/create-hogsend/template/src/webhook-sources/posthog.ts` · _Depends:_ —

D3 is RESOLVED — the key is `` `posthog:${eventUuid}` ``, scope-independent — but the
resolution has a prerequisite nobody owned. **The real-time webhook source stamps no
idempotencyKey today.** Verified: it reads `payload.event.uuid` and puts it in
`eventProperties._posthogEventId` (`posthog.ts:59-61`), then returns an `IngestEvent` with
no `idempotencyKey` field at all. A NULL key never participates in
`user_events_idempotency_key_idx`, so backfill and real-time cannot dedupe against each
other and AC 9 is unsatisfiable.

Set `idempotencyKey: \`posthog:${payload.event.uuid}\`` when a `uuid` is present; leave it
unset when it is absent (never fabricate one). Keep `_posthogEventId` — other things may
read it.

**Both copies must change.** The dogfood consumer at `apps/api/` and the scaffold template
at `packages/create-hogsend/template/` carry independent copies of this source; a fix to
only one ships a scaffold whose backfill silently double-sends.

Additive and needs no migration — Postgres treats NULL as distinct in a unique index, so
existing null-keyed rows are unaffected and simply never participate. Record the ship date;
AC 9a's "forward of T06.0" disclaimer is keyed to it.

### T06.1 — PostHog historical event pull
_Boundary:_ `packages/plugin-posthog` · _Depends:_ PRD 00 (for `resolvePostHogPerson`)

Hand-rolled, paginated, rate-limited pull of raw PostHog events for a date window
(`--since`/`--max-age`), via PostHog's Query API (HogQL) — **verified: no existing code
in this repo does this today** (searched `plugin-posthog`/`engine`/`cli` for
`query/read`/HogQL/`/api/projects.*query` — zero hits; this is genuinely new, per
DECISIONS §2.10's "every one is a hand-rolled `fetch`" pattern). Reuse
`createRateLimitedFetch` **from `@hogsend/core`** — DECISIONS §2.10 locks a prerequisite
task moving it out of `packages/cli/src/lib/import-shared.ts:96-148`, because
`plugin-posthog` may not import from `@hogsend/cli` (workspace dependency cycle) — and the
OAuth-preferred/personal-key-fallback/host-derivation pattern from `properties.ts`
(mirrors PRD 02 T02.1's cohort client — coordinate with that PRD to avoid duplicating the
credential-resolution logic twice; extract a shared helper if both land close together).
Each pulled event carries PostHog's own `uuid` (for the idempotency key, D3),
`distinct_id`/`person_id`/`timestamp`/`event`/`properties`.

### T06.2 — Dry-run evaluation engine
_Boundary:_ `packages/engine/src/lib/` (new module, e.g. `backfill-dry-run.ts`) ·
_Depends:_ T06.1, PRD 00 T00.3

Implement the per-step suppression table from D2 as a pure(ish), read-only evaluation
function: given a resolved `IngestEvent`-shaped historical event, walk
`registry.getByTriggerEvent`, apply the documented enrollment-guard order
(`meta.enabled` → `evaluateTriggerConditions` → `checkEntryLimit` (RUN FOR REAL against
the real clock, per D1) → `checkEmailPreferences`), and produce a structured
would-enroll/would-skip report per candidate journey, with the D1 caveat surfaced
per-result (AC 7). Also read (never mutate) `checkExits`'s candidate set for informational
"would also exit" reporting. Does NOT touch `checkBucketMembership`'s internals — treats
bucket-transition reporting as its own smaller read-only re-implementation (see D2 step 13
rationale) rather than modifying the shared function's contract.

### T06.3 — Backfill idempotency key + `--send` execution path
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ T06.0, T06.1

D3 is **RESOLVED** — the key is `` `posthog:${eventUuid}` ``, scope-independent, with
`backfillJobId` deliberately NOT part of it. No reviewer round-trip is needed; implement it
as locked. The real-time half of that key is T06.0. Thread it as
`IngestEvent.idempotencyKey`, and thread `occurredAt` from the pulled event's PostHog
timestamp (closing the gap identified in D4 relative to the existing replay route —
without touching that route). Satisfies AC 2, 3, 9.

### T06.4 — The backfill workflow task
_Boundary:_ `packages/engine/src/workflows/` (new file, modeled on
`bucket-backfill.ts`) · _Depends:_ T06.2, T06.3

A new Hatchet task, `retries: 0` (mirroring `bucketBackfillTask`,
`bucket-backfill.ts:79-82`), self-bootstrapping `db`/`logger` from `process.env` like
every other cron/backfill task in this codebase. Reuses the `import_jobs` status-record
pattern exactly as `bucketBackfillTask` does: `fileName`/`format` discriminator (a new
format string, e.g. `"posthog-backfill"`), `status`/`totalRows`/`processedRows`/
`errors` progress fields, and a resumable page cursor persisted the same way PRD 02's
poller is required to (DECISIONS §2.4's cursor requirement) — satisfies AC 6. **Note
`import_jobs` has no cursor/metadata column today** (`packages/db/src/schema/import-jobs.ts:12-26`);
it is added by PRD 02 T02.0, or hoisted into PRD 00 T00.1 if this PRD ships first (see
T00.1's migration-batching note). Do not add it twice. Applies
`--max-age` as a pre-filter before any event reaches T06.2/T06.3 (D5, AC 4, 5).

### T06.5 — CLI command
_Boundary:_ `packages/cli` (new `backfill.ts` command, modeled on `import.ts`'s
submit/poll shape using `submitImportJobs`/`pollImportJobs` conventions from
`packages/cli/src/lib/import-shared.ts`) · _Depends:_ T06.4

`hogsend backfill --since <duration> [--send] [--max-age <duration> |
--i-understand-no-max-age]`. Default (no `--send`) is dry-run; prints the per-event
report from T06.2 including the AC 7 disclaimer prominently, not buried. Refuses to run
per AC 5/8 with actionable errors.

## Seams

A real PostHog project with a genuine historical event stream is needed for full
end-to-end verification of the Query API pull (pagination, rate-limit behavior against
real limits — DECISIONS §7 already flags PostHog's real rate-limit numbers as a
human-input seam shared with PRD 02). Build and demo against a deterministic Fake event
stream covering: happy-path dry-run, happy-path `--send`, a re-run of the same job id
(no double-send), an event older than `--max-age` (dropped + counted), and an interrupted
pull resuming from cursor. Enumerate the real-project run as a human verification step.

## Done when

All ACs pass, gates green, and: (a) a dry-run against the Fake reports would-enroll
results with zero rows written to
`user_events`/`bucket_memberships`/`journey_states`/`contacts`,
(b) `--send` against the same Fake produces the real rows with correct historical
`occurred_at` timestamps, (c) re-running the identical `--send` job a second time
produces zero additional sends, and (d) an event manufactured to be older than
`--max-age` is dropped and reported, never reaching `ingestEvent`.

## Implementation Notes
