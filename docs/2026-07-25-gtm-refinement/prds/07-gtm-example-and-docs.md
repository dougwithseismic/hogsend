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

_(filled in during build)_
