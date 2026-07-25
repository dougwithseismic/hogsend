# Production readiness — GTM Refinement

What "done" means for this release, in priority order. Nothing below is optional for a deploy that
spends real money against a vendor API and runs inside durable journeys.

Status legend: `[x]` done · `[~]` in flight · `[ ]` not started

---

## 0. The systemic problem, first

**Four positional-journal bugs in one release.** Not four unlucky mistakes — one design that invites
the mistake, hit four times by three different authors (the plan, the implementation, and twice more
found only by adversarial review):

1. Gate chain early-returned `cached` before `memoize` (caught in plan review, pre-code).
2. The memo key derived from `refined_company_domain` — a value the function itself writes.
3. `resolveTarget`'s live `contacts` read sat outside the closure, so both the *decision to issue*
   `memoize` and the key derived from mutable state (reproduced: double vendor spend).
4. The `no_lookup_key` path issued **zero** durable calls, and a test asserted that as correct.

The law is real and correct — `packages/engine/src/lib/feed.ts:152-165` states it plainly. But it is
**prose enforced by nothing**. Every new durable side-effect helper (`sendEmail`, `sendSms`,
`sendConnectorAction`, now `refineContact`) re-derives the correct shape from scratch, and the shape
is easy to get subtly wrong in a way every gate reports green.

- [x] **P0 — Extract the shape into one primitive.** `withDurableGate` shipped in `660a08a9`
      (`packages/engine/src/journeys/with-durable-gate.ts`). It owns the whole ordering: resolve
      boundary → direct-run when there is none → derive key from caller arguments only → `registerKey`
      → `memoize` unconditionally, with nothing between the boundary check and the memoize that reads
      a database or branches on one. `refineContact` is ported; its suites pass **unmodified**, which
      is what makes it an extraction rather than a rewrite.
- [x] **P0 — Make the law testable, not just documented.** `durable-law-harness.ts` generalises the
      AC 11 technique: drive any durable function through every return path with a recording boundary
      and assert the durable-call journal is byte-identical. Every future durable helper gets it free.
- [x] **P1 — A rule that outranks the prose.** `CallerRef` is a branded type over a module-private
      `unique symbol`, so a bare `string` — including anything that arrives via `await` — is a
      compile error at the call site. TypeScript cannot track provenance through data flow, so the
      type does the achievable thing instead: it collapses construction to ONE sanctioned site
      (`callerRefFromArgs`) plus a greppable cast. "Did the author obey a prose law?" (missed four
      times) becomes "is there a cast in this diff?" (unmissable).
- [ ] **Follow-up, not this release:** port `sendEmail`, `sendSms`, `sendConnectorAction` to the
      primitive. Deliberately deferred — each has its own subtleties and test surface, and doing all
      four at once turns a safe extraction into a risky one.

---

## 1. Correctness — must all be closed

What was wrong, all four found by adversarial review AFTER the code was committed on green gates:
- **D1 (blocking)** — `memoize` issuance and key both derived from a live `contacts` read outside the
  closure. Two reproduced variants: journal shift (run killed), and double vendor spend with a
  duplicate `contact.refined` ingest.
- **D2 (blocking)** — a `cached` verdict returned the caller's own traits and wrote nothing, so on a
  shared (domain) key every contact after the first was silently starved: no traits, no ingest, no
  bucket re-evaluation, no error.
- **D3 (blocking)** — the budget cap counted ledger ROWS while `force` upserts in place, so a `force`
  loop spent without limit.
- **D4 (important)** — a provider error on an existing key recorded nothing (uncapped, invisible
  outage retries), and a failed `ingestEvent` threw after the paid row was committed.

- [x] **D1–D4 all closed** in `c9aed857`, and re-verified by REPRODUCTION rather than diff-reading:
      two independent advisors re-drove the real `refineContact` against the live DB and could not
      reproduce any of the four. Mutation evidence is the load-bearing part — restoring D1's old shape
      fails 8 tests; reverting D3's counting fails its own. Engine 47→56, refine vitest 13→18, zero
      regressions, no assertion deleted or loosened.
      - D2's semantics were settled deliberately: **`cached` means "this lookup key was already paid
        for", NOT "this contact already has the answer"**. A hit lands the stored patch on the contact
        being asked about. That is what makes a shared domain key work, and what makes D4b's retry free.
- [ ] **Concurrency** — two `refineContact` calls racing the same key in different processes. The
      unique index makes one lose; confirm the loser returns a sane verdict rather than a 23505 escape.
      Not yet tested at all.
- [ ] **Degraded mode (pre-eviction engine)** — a domain→email upgrade can still double-charge, because
      `memoize` falls through to a bare call and Layer 2 is subject-keyed rather than caller-keyed.
      Same accepted gap class as `sendConnectorAction`. Eviction IS live on this stack
      (hatchet-lite 0.84.0) so Layer 1 covers the normal path — but a deploy on an older engine does
      not have that protection. Decide explicitly whether to support it or refuse to boot on it.

---

## 2. Verification we have NOT done

The 12/12 runtime smoke covered one contact, with an email, on the happy path, against real Apollo.
That is a real result and it is also a narrow one.

- [x] **A real replay drill — PASSED.** Journey → `refineContact` → `ctx.sleep` → `kill -9` the
      worker mid-sleep → restart → the run resumed, the journal held, and the vendor was charged
      exactly once. Run twice: once against the fixed code, once against the D1 mutation, and the
      mutation double-charged. That second run is the load-bearing half — a drill that only passes
      proves the harness ran, not that it can detect the bug.
- [ ] **The unhappy vendor paths, live.** `not_found` (an address Apollo does not know) and
      `provider_error` (deliberately invalid key → 401) against the real API, asserting the ledger
      row shape and that a retry after an error actually re-attempts.
- [ ] **TTL expiry.** Backdate a ledger row past `expiresAt` and confirm the vendor is re-asked.
      Currently only the cache-hit direction is proven.
- [x] **Bucket leave.** Covered by PRD 07's `gtm-qualified-ingest.test.ts` — a score of 40 enters,
      a later score of 5 leaves, both through `ingestEvent` alone with no reconcile cron.

---

## 2b. Test isolation is broken repo-wide — PRE-EXISTING, and it undermines every verification claim

**150 of 151 files in `apps/api/src/__tests__/` do this, unconditionally:**

```js
process.env.DATABASE_URL = "postgresql://growthhog:growthhog@localhost:5434/growthhog";
```

No env escape. Port **5434 is the main checkout's database** — shared with whatever other agent or
dev session is running. Only `refine-contact.test.ts` respects an override
(`HOGSEND_TEST_DATABASE_URL`), because it was written during this release.

Consequences, all real and all observed:
- A full `apps/api` suite run from ANY worktree writes to the shared DB. The "1933 passed" figures
  earlier in this release were partly against another agent's data.
- Concurrent sessions flake each other. `admin-impact-global-control.test.ts` is the reliable victim:
  its oracle enumerates ALL live contacts assuming no concurrent mutation, which cannot hold on a
  shared database. It passes 5/5 in isolation and fails under concurrency — the failure looks like a
  logic bug and is not one.
- Worktree isolation, which exists precisely so parallel agents do not corrupt each other, is
  defeated for the one thing most likely to write rows.

- [x] **Swept — PRD 10, `39db62e0`.** All 151 files now read
      `process.env.DATABASE_URL = process.env.HOGSEND_TEST_DATABASE_URL ?? <default>`. The default is
      deliberately unchanged, so anyone with nothing exported sees identical behaviour. Two files the
      mechanical pattern missed were fixed by hand, including one doing
      `DROP DATABASE … WITH (FORCE)` against a hardcoded server.
      After the sweep, a genuinely isolated full run gave **1949 passed / 3 skipped / 193 files / 0
      failures** — the first figure in this release not contaminated by a shared database.
- [ ] Consider making the default port itself worktree-derived, so the failure mode is "cannot
      connect" rather than "silently wrote to someone else's database".

Not caused by this release. Flagged here because it materially weakens the evidence behind any
"tests are green" claim made from a worktree, including several of mine.

## 3. Remaining scope

- [x] **PRD 04** — `@hogsend/plugin-apollo`, shipped in `e737b766`. Built against the probed contract
      (array `departments` → first element, `primary_domain` not `website_url`, nulls omitted rather
      than written). 17 tests, injectable `fetch`, no network and no API key needed to run them.
- [x] **PRD 05** — cold-channel gate, shipped in `825eb998`. Gate runs inside the existing memo
      closure; the durable key derivation and memoize call are byte-identical. Mutation-verified
      independently: inverting the posture check kills 3 tests.
- [x] **PRD 06** — leaderboard, shipped in `ae47d78e`. The `jsonb_typeof` guard is in (4 call sites,
      sort + filter); without it a single non-numeric value in the jsonb bag 500s the endpoint. GIN
      index in migration `0067`. **Deferred: the Studio screenshot** — it needs a running app, which
      the tree now supports.
- [x] **PRD 07** — example + scoring workflow (`4e280906`) + docs (`0f67b8d9`). Review caught three
      defects before commit — a missing `contactId` provenance pin, a self-feeding recency metric,
      and a day-scoped `idempotencyKey` that skipped the bucket check — all four fixes
      mutation-tested rather than assumed.
- [x] **PRD 08** — `contact.refined` outbound, shipped in `11189192`. Not cut. Review caught a
      dedupe key with no time component: `webhook_deliveries` has a PERMANENT unique
      `(endpointId, dedupeKey)`, so a TTL-expiry re-refinement reporting a new job title would have
      recomputed a byte-identical key and never reached the subscriber.
- [ ] **PRD 11 / [#608](https://github.com/dougwithseismic/hogsend/issues/608)** — NOT this release.
      Pre-existing: `emitBucketTransition` re-ingests with no `contactId` pin, so EVERY bucket mints
      a phantom twin for an anonymous-only contact. Found and reproduced live during PRD 07's
      review. A test in `gtm-qualified-ingest.test.ts` pins the current buggy shape so the fix has a
      target that cannot be forgotten.

---

## 4. Operational

- [ ] **Spend is observable.** `budget_exceeded` currently logs a warning and returns a status. A
      deployment needs a metric or an alert — the failure mode is silent under-enrichment, which looks
      like "the feature does nothing" rather than an error.
- [ ] **Rotate the Apollo key** before any shared/production use — the current one was pasted into a
      chat transcript. It is correctly gitignored and absent from all history, but that is a different
      exposure.
- [ ] **`ENRICHMENT_MONTHLY_LOOKUPS` set deliberately per environment.** Default `0` is UNCAPPED;
      local is pinned to 50. An unset production deploy has no ceiling.
- [x] **Changeset written and verified** (`04a5ff8e`). Two files, the blessed pattern: the feature
      changeset (`core`, `db`, `engine`, `plugin-apollo`, `cli`, `client`) plus the companion
      `engine-line-uniform.md` generated by `pnpm changeset:engine-line`. 24 packages at `minor`.
      `pnpm release-doctor` passes all 15 invariants, including "pending changesets keep the engine
      version line uniform" — the check that silently blocks the Version PR when it fails.
      `@hogsend/plugin-apollo` needed no manifest registration: the uniformity check is disk-derived,
      so a new publishable `@hogsend/*` package is covered automatically.
      CI publishes brand-new packages fine; the "first publish must be manual" rule is dead
      (disproved by `sms`/`plugin-twilio` in 0.43.0 and `attribution`/`plugin-meta-capi` in 0.44.0).
      A fresh packument can 404 anonymously for ~15 min after a successful publish — probe the
      tarball, don't call an incident.
- [ ] **Migration 0065 on a populated database.** Additive and reviewed as safe, but not yet applied
      to anything with real row counts.

---

## 4b. Final gate run — 2026-07-25

Everything below was run from this worktree against its OWN isolated stack (5438/6383), not the
shared main-checkout database.

| Gate | Result |
| --- | --- |
| `pnpm lint` | clean — 13 warnings, all pre-existing, none in changed files |
| `pnpm exec turbo run check-types --concurrency=2` | 50/50 |
| `pnpm exec turbo run build --concurrency=2` | 27/27 |
| `pnpm exec turbo run test --concurrency=2 --filter='!@hogsend/api'` | 41/41 |
| `apps/api` full suite | **1978 passed · 3 skipped · 196 files · 0 failures** |
| `packages/engine` (node:test) | **94 passed · 0 failures** |
| `pnpm release-doctor` | all 15 invariants OK |

The `apps/api` count moved 1949 → 1978, exactly the 29 tests PRD 07 added. PRD 08's tests are
node:test in the engine, which is why the engine count moved 83 → 94 instead.

Ten mutations were run across this release, each one restored immediately after and verified clean
by `diff`. Every one killed at least one test:

| Mutation | Tests failed |
| --- | --- |
| `gte(20)` → `gte(200)` on the score bucket | 2 |
| weaken the jsonb `finiteNumber` guard | 1 |
| remove the recency `FILTER` (the self-feeding metric) | 1 |
| drop the `contactId` provenance pin | 2 |
| let `not_found` fall through to the outbound emit | 1 |
| strip the instant from the outbound dedupe key | 3 |

## 5. The bar

Call it production-safe when: §1 is fully closed and re-verified by reproduction (not by reading a
diff), the replay drill in §2 passes against a real killed worker, and §0's P0 items are done so the
fifth bug of this class cannot be written in the first place.

Ship-blocking subset if you need the shortest path: **D1, D2, D3, the replay drill, and the
`ENRICHMENT_MONTHLY_LOOKUPS` default.** Everything else can follow.
