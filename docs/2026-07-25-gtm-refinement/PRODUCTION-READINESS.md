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

- [ ] **Sweep all 151 files to `process.env.DATABASE_URL = process.env.HOGSEND_TEST_DATABASE_URL ?? <default>`.**
      Mechanical, no behaviour change for anyone running the default. Do it when no other agent is
      mid-edit in `apps/api` — it touches too many files to interleave safely.
- [ ] Consider making the default port itself worktree-derived, so the failure mode is "cannot
      connect" rather than "silently wrote to someone else's database".

Not caused by this release. Flagged here because it materially weakens the evidence behind any
"tests are green" claim made from a worktree, including several of mine.

## 3. Remaining scope

- [ ] **PRD 04** — `@hogsend/plugin-apollo`. Build against the probed contract in the PRD (array
      `departments`, `primary_domain` not `website_url`, nullable person `linkedin_url`).
- [x] **PRD 05** — cold-channel gate, shipped in `825eb998`. Gate runs inside the existing memo
      closure; the durable key derivation and memoize call are byte-identical. Mutation-verified
      independently: inverting the posture check kills 3 tests.
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
- [ ] **`@hogsend/plugin-apollo` needs a changeset** so the release train picks it up. CI publishes
      brand-new packages fine — the "first publish must be manual" rule is dead (disproved by
      `sms`/`plugin-twilio` in 0.43.0 and `attribution`/`plugin-meta-capi` in 0.44.0, all
      first-published by CI). `verify-published.mjs` backstops it. A fresh packument can 404
      anonymously for ~15 min after a successful publish; probe the tarball, don't panic.
- [ ] **The changeset must list EVERY engine-line package**, or `release-doctor` blocks the Version
      PR silently (no PR appears at all). Check `gh run view --log | grep release-doctor` if it
      doesn't show up.
- [ ] **Migration 0065 on a populated database.** Additive and reviewed as safe, but not yet applied
      to anything with real row counts.

---

## 5. The bar

Call it production-safe when: §1 is fully closed and re-verified by reproduction (not by reading a
diff), the replay drill in §2 passes against a real killed worker, and §0's P0 items are done so the
fifth bug of this class cannot be written in the first place.

Ship-blocking subset if you need the shortest path: **D1, D2, D3, the replay drill, and the
`ENRICHMENT_MONTHLY_LOOKUPS` default.** Everything else can follow.
