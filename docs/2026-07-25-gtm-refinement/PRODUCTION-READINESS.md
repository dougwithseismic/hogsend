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

- [ ] **P0 — Extract the shape into one primitive.** A `withDurableGate({ boundary, kind, callerRef,
      idempotencyLabel }, gates)` helper in `packages/engine/src/journeys/` that owns the whole
      ordering: derive key from CALLER ARGUMENTS only → `registerKey` → `memoize` unconditionally →
      run every stateful gate inside the closure → direct-run when there is no boundary. Port
      `refineContact` to it first, then the other three helpers. Authors then cannot get the ordering
      wrong, because the ordering is not theirs to write.
- [ ] **P0 — Make the law testable, not just documented.** A shared test helper that drives any
      durable helper through *every* return path with a recording boundary and asserts the durable
      call journal is byte-identical. `refine-chain.test.ts`'s AC 11 test is the template; it is the
      only reason defect 4 was catchable at all.
- [ ] **P1 — A rule that outranks the prose:** no input to `deriveJourneyKey` may come from a DB read.
      Encode it in the helper's type signature (`callerRef` accepts only values derived from the
      options object), so violating it is a type error rather than a code-review catch.

---

## 1. Correctness — must all be closed

- [~] **D1 (blocking)** — `memoize` issuance and key both derived from a live `contacts` read outside
      the closure. Two reproduced variants: journal shift (run killed) and double vendor spend with
      duplicate `contact.refined` ingest. *Fix in flight.*
- [~] **D2 (blocking)** — a `cached` verdict returns the caller's own traits and writes nothing, so on
      a shared (domain) key every contact after the first is silently starved: no traits, no ingest,
      no bucket re-evaluation, no error. *Fix in flight.*
- [~] **D3 (blocking)** — budget cap counts ledger ROWS while `force` upserts, so repeated `force`
      spends without limit. The cap must count LOOKUPS. *Fix in flight.*
- [~] **D4 (important)** — a provider error on an existing key records nothing (uncapped, invisible
      outage retries); a failed `ingestEvent` throws after the paid row is committed. *Fix in flight.*
- [ ] **Concurrency** — two `refineContact` calls racing the same key in different processes. The
      unique index makes one lose; confirm the loser returns a sane verdict rather than a 23505 escape.
      Not yet tested at all.

---

## 2. Verification we have NOT done

The 12/12 runtime smoke covered one contact, with an email, on the happy path, against real Apollo.
That is a real result and it is also a narrow one.

- [ ] **A real replay drill.** The single highest-value test we are missing, and it targets the exact
      bug class that has now recurred four times. Enroll a journey → `refineContact` → `ctx.sleep` →
      `docker kill` the worker mid-sleep → restart → assert the run resumes, the journal holds, and
      the vendor is charged exactly once. Everything so far has been reasoned or stub-driven; nothing
      has survived an actual Hatchet replay.
- [ ] **The unhappy vendor paths, live.** `not_found` (an address Apollo does not know) and
      `provider_error` (deliberately invalid key → 401) against the real API, asserting the ledger
      row shape and that a retry after an error actually re-attempts.
- [ ] **TTL expiry.** Backdate a ledger row past `expiresAt` and confirm the vendor is re-asked.
      Currently only the cache-hit direction is proven.
- [ ] **Bucket leave.** A contact whose refined trait drops below a bucket threshold. Only entry has
      been demonstrated.

---

## 3. Remaining scope

- [ ] **PRD 04** — `@hogsend/plugin-apollo`. Build against the probed contract in the PRD (array
      `departments`, `primary_domain` not `website_url`, nullable person `linkedin_url`).
- [ ] **PRD 05** — cold-channel gate. Independent; closes a declared-but-unwired safety gap that a
      GTM release makes live.
- [ ] **PRD 06** — leaderboard. Spec already corrected for the `jsonb_typeof` guard; without it a
      single non-numeric value 500s the endpoint and the documented index breaks ingest writes.
- [ ] **PRD 07** — example + docs + the end-to-end smoke as a committed artifact rather than a
      throwaway script.
- [ ] **PRD 08** — `contact.refined` outbound. Cuttable.

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
- [ ] **First npm publish of `@hogsend/plugin-apollo` is manual** — CI cannot create a new package.
- [ ] **Migration 0065 on a populated database.** Additive and reviewed as safe, but not yet applied
      to anything with real row counts.

---

## 5. The bar

Call it production-safe when: §1 is fully closed and re-verified by reproduction (not by reading a
diff), the replay drill in §2 passes against a real killed worker, and §0's P0 items are done so the
fifth bug of this class cannot be written in the first place.

Ship-blocking subset if you need the shortest path: **D1, D2, D3, the replay drill, and the
`ENRICHMENT_MONTHLY_LOOKUPS` default.** Everything else can follow.
