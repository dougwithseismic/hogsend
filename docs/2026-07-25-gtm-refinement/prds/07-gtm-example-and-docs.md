# PRD 07 — GTM example buckets, scoring recipe, docs

**Depends on:** PRD 03, PRD 04, PRD 06 · **Status:** `[ ]`

## Goal

Make the loop real and teachable: a working example in `apps/api` that a reader can copy, plus the
docs that explain refinement and the scoring pattern. This is where "Signals = a bucket you can rank"
gets written down.

## Locked decisions

- The score is **plain TypeScript in the consumer app**, not an engine primitive. That is the wedge.
- **Recompute, never increment** (DECISIONS §3.2). The scoring function is a pure function of current
  contact state. Any example that does a read-modify-write increment is wrong and must not ship.
- The nightly recompute **must write each score through `ingestEvent`**. `bucketReconcileTask`
  deliberately skips non-time-based buckets, so a pure `gte` bucket is only ever evaluated from
  ingest. Cost: one `user_events` row per scored contact per run. State this cost in the docs — do
  not hide it.
- The refine call sits in a **bucket enter reaction**, wrapped in `ctx.once` — a reaction handler runs
  inside a replayable journey run.
- Batched writes follow `examples/my-first-hogsend/src/workflows/backfill-example.ts`
  (`FOR UPDATE SKIP LOCKED`).

## Acceptance criteria (EARS)

1. WHEN a contact enters `gtm-high-intent` the system SHALL call `refineContact()` exactly once per
   entry, wrapped in `ctx.once`.
2. WHEN the nightly scoring workflow runs the system SHALL recompute each contact's `gtmScore` as a
   pure function of current state and write it via `ingestEvent`.
3. WHEN a contact's recomputed `gtmScore` crosses 20 the contact SHALL enter `gtm-qualified` without
   waiting for the reconcile cron.
4. WHEN the scoring workflow runs twice with unchanged inputs the resulting `gtmScore` SHALL be
   identical (deterministic, no clock- or RNG-derived term beyond an explicit decay input).
5. WHEN the docs are read they SHALL state the per-contact `user_events` cost of the nightly
   recompute, the flat-top-level-key rule, and the expression-index one-liner from PRD 06.

## Tasks

### T7.1 — Example buckets + reaction
_Boundary:_ `apps/api` · _Depends:_ PRD 03

`src/buckets/gtm-high-intent.ts` (behavioural criteria) with `.on("enter")` → `refineContact()` in
`ctx.once`; `src/buckets/gtm-qualified.ts` with `criteria: (b) => b.prop("gtmScore").gte(20)`.
Register both wherever the app's buckets are wired.

### T7.2 — Nightly scoring workflow
_Boundary:_ `apps/api` · _Depends:_ T7.1

`src/workflows/gtm-score.ts` — `hatchet.task({ onCrons })`, batched, writing through `ingestEvent`.
Export from `src/workflows/index.ts` and pass via `createWorker({ extraWorkflows })`.

_Test:_ AC 2 and AC 4 against the scoring function directly (pure), plus an integration test for AC 3.

### T7.3 — Docs
_Boundary:_ `docs` + `apps/docs` · _Depends:_ T7.2

`docs/gtm.md` (the engine-side reference, following `docs/byo-email-provider.md` as the canonical BYO
template) and `apps/docs/content/docs/guides/refinement.mdx` (the consumer-facing guide). Cover: the
provider contract, `refineContact` semantics and every return status, the ledger/TTL/budget model,
the trait key rules, the scoring pattern, and the leaderboard query. Follow the house copy register —
every line a fact, no marketing, no em dashes.

## Harness gotchas — hit and solved during the 2026-07-25 runtime smoke

The full loop HAS been driven end to end against real Apollo, real Postgres and a live hatchet-lite.
It passes. Three traps cost real time; none is a product defect, all three silently produce a
green-looking run that proves nothing:

1. **`setBucketRegistry` must be called AFTER `createHogsendClient`.** The container builds its own
   bucket registry from `opts.buckets` and calls `setBucketRegistry` itself, clobbering anything set
   earlier. Set it first and membership silently never fills — no error, just zero rows.
2. **`buildBucketRegistry(buckets, "*")` — the second argument is the enabled-buckets filter**
   (`ENABLED_BUCKETS` semantics). Omit it and nothing is enabled, again silently.
3. **`contacts.email` is UNIQUE.** Re-seeding a fixture contact with `onConflictDoNothing` is a
   silent no-op, after which `refineContact({ userId })` resolves nothing and correctly returns
   `no_lookup_key` — which reads like a refinement bug and is not one.

Also: `ingestEvent` compensating-deletes the `user_events` row and **rethrows** if the Hatchet push
fails, and the contact upsert plus bucket check both run after that point. So a live Hatchet is
genuinely required for an end-to-end smoke — it cannot be stubbed away. For this worktree,
hatchet-lite runs on 7081/8891 and a token is minted with:
`docker exec <hatchet-lite> /hatchet-admin token create --name <n> --tenant-id <id> --config /config`
(note `--config /config`, not `/app/config`; the tenant id is printed in the container logs at boot).

## Seams

**A live Apollo API key** — CLOSED. Supplied and verified. The example and its tests still run against
the fake provider from PRD 03, so the suite stays offline and deterministic.

## Done when

Five acceptance criteria pass, gates green, and the full loop has been driven end to end against a
running API + worker (see the verification section of the approved plan).

## Implementation Notes

Shipped in `4e280906` (example + scoring) and `0f67b8d9` (docs).

**What landed**

- `apps/api/src/buckets/gtm-high-intent.ts` — behavioural criteria (5+ key actions in 30 days AND a
  commercial signal) with `.on("enter")` → `ctx.once("refine", …)` → `refineContact`.
  `entryLimit: "once_per_period"` / `entryPeriod: days(30)` because every entry can spend a lookup;
  30 days sits well inside the 90-day enrichment TTL, so a re-entry is a `cached` no-spend. The
  cooldown bounds reaction RUNS; the ledger bounds the MONEY.
- `apps/api/src/buckets/gtm-qualified.ts` — `b.prop("gtmScore").gte(20)`, deliberately not
  `timeBased`.
- `apps/api/src/workflows/gtm-score.ts` — `computeGtmScore` (pure) + `selectScoreBatch` (the SQL,
  exported so tests drive the real query) + the nightly cron task.
- `apps/api/src/journeys/constants/events.ts` — `GTM_SCORED: "gtm.scored"`, the carrier for the
  score write.
- `docs/gtm.md` + `apps/docs/content/docs/guides/refinement.mdx` (+ `meta.json` ordering). The guide
  was rendered in the running docs app before commit, not just built.

**Scoring shape** — FIT (max 50: seniority band, company-size band, target industry, known domain)
+ BEHAVIOUR (max 50, every axis capped so one loud signal cannot dominate) × a recency multiplier
applied to the behaviour half only. Fit does not go stale on the same timescale as intent.
`daysSinceLastActivity` is an ARGUMENT, never a clock read, which is what makes the function
testable.

**Batch termination** — `runBatchedBackfill` stops on a 0-return and otherwise assumes each batch
shrinks the remaining set. A recompute shrinks nothing, so a naive `LIMIT n` re-selects the same
page forever. A keyset cursor on `contacts.id` fixes it, and `runBatch` returns rows **SCANNED**,
not rows written — returning rows-written would let a stretch of unchanged contacts return 0 and
silently end the run early, skipping everything after them.

### Three defects caught by review, all fixed before commit

1. **Missing `contactId` provenance pin (blocking).** `user_key` is
   `COALESCE(external_id, anonymous_id, id)`, but `resolveOrCreateContact` treats a bare `userId` as
   an EXTERNAL key and never probes `anonymous_id`. An anonymous-only contact would have had a
   phantom twin minted carrying the score while the real row stayed at `{}` — and because the real
   row's score stayed absent, skip-unchanged never fired, so it would re-mint nightly forever
   without converging. Reproduced live by two independent reviewers.
2. **Self-feeding recency metric (blocking).** `MAX(occurred_at)` was unfiltered, so it counted
   `gtm.scored` — the row this job writes. Every scored contact looked active as of its own last
   scoring, resetting decay to 1.0 on the next run and inflating a score that had not moved. Now
   filtered to the four events the score actually reads.
3. **Day-scoped `idempotencyKey` (removed).** It looked like a retry guard and was a trap:
   `ingestEvent` commits the property patch in step (1) but returns `stored: false` from the dedupe
   in step (4), BEFORE `checkBucketMembership` in step (6). A score revisiting a same-day value
   would land the number and skip the membership re-evaluation, leaving a contact reading 34 while
   absent from `gtm-qualified` — with nothing to heal it, because a pure `prop` bucket is invisible
   to the reconcile cron. The retry protection it reached for already comes from skip-unchanged: a
   Hatchet retry rescans from a reset cursor and every already-written contact matches its stored
   score.

### A fourth defect, NOT fixed here

The anon-only fix exposed a **pre-existing engine defect**: `emitBucketTransition` re-ingests every
bucket transition with no `contactId` pin, so ANY bucket mints a phantom twin for an anonymous-only
contact. `power-users`, `went-dormant` and `trial-expiring-soon` have the same exposure. Filed as
**PRD 11** and as a GitHub issue; out of PRD 07's boundary and worth its own review surface (seven
call sites across three files, including the reconcile cron and backfill, which are the paths that
could mint at scale).

`gtm-qualified-ingest.test.ts` carries a test named **`KNOWN DEFECT (PRD 11)`** that PINS the
current buggy shape (`toHaveLength(2)`). It will FAIL when PRD 11 lands. That is deliberate — it
gives the fix a target that cannot be forgotten.

### Verification

29 tests across three files, and every fix mutation-tested rather than assumed:

| Mutation | Result |
| --- | --- |
| `gte(20)` → `gte(200)` | 2 tests fail |
| weaken the jsonb `finiteNumber` guard | 1 test fails |
| remove the recency `FILTER` | 1 test fails |
| drop the `contactId` pin | 2 tests fail |

Plus 139 passing across the nine bucket + GTM suites, no regressions.

`selectScoreBatch` was extracted specifically so the SQL is reachable from a test. The subtle
mistakes live in the query — the recency filter, the identity `COALESCE`, the cursor — and none of
it is reachable through `computeGtmScore`.

### Not done

AC 5's Studio screenshot (deferred from PRD 06) still needs a Studio pass against a running app.
