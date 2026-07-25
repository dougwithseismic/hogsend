# PRD 10 — Test database isolation

**Depends on:** none (but needs `apps/api` quiet) · **Status:** `[ ]` · **Priority: P0**

## Goal

Stop test runs from any worktree writing to the shared main-checkout database.

## Why

**150 of 151 files in `apps/api/src/__tests__/` do this, unconditionally:**

```js
process.env.DATABASE_URL = "postgresql://growthhog:growthhog@localhost:5434/growthhog";
```

No env escape. Port 5434 belongs to the main checkout, shared with whatever other agent or dev
session is live. Only `refine-contact.test.ts` respects an override, because it was written during
this release.

Observed consequences, not hypothetical:
- A full suite run from ANY worktree writes to the shared DB. Several "tests are green" figures
  earlier in this release were partly measured against another session's data.
- `admin-impact-global-control.test.ts` flakes under concurrency and passes 5/5 in isolation: its
  oracle enumerates ALL live contacts assuming no concurrent mutation, which cannot hold on a shared
  database. The failure reads like a logic bug and is not one.
- A separate, worse instance already bit: `refine-contact.test.ts` wiped the whole
  `enrichment_lookups` table — the exactly-once backstop AND the budget ledger — out from under a
  live replay drill. Fixed in `47d11816` by scoping the delete, but the class of problem is general.

Worktree isolation exists so parallel agents cannot corrupt each other. It is currently defeated for
the one operation most likely to write rows.

## Locked decisions

- **Mechanical and behaviour-preserving.** Anyone running with no env set keeps today's behaviour
  exactly. This must not become a refactor.
- The pattern, matching `refine-contact.test.ts`:
  ```js
  process.env.DATABASE_URL =
    process.env.HOGSEND_TEST_DATABASE_URL ??
    "postgresql://growthhog:growthhog@localhost:5434/growthhog";
  ```
- **Do not change the default port.** Changing it would silently repoint every existing developer's
  suite. Making the override possible is this PRD; choosing a better default is a separate decision.
- Run only when no other agent is mid-edit in `apps/api` — 150 files cannot interleave safely.

## Acceptance criteria (EARS)

1. WHEN `HOGSEND_TEST_DATABASE_URL` is set every file in `apps/api/src/__tests__/` SHALL use it.
2. WHEN it is unset every file SHALL use the current hardcoded default, unchanged.
3. WHEN the sweep is complete a grep for an unconditional `process.env.DATABASE_URL = "` assignment in
   that directory SHALL return zero results.
4. WHEN the full suite runs against an override the previously-passing tests SHALL still pass.

## Tasks

### T10.1 — The sweep
_Boundary:_ `apps/api/src/__tests__` · _Depends:_ —

Script it; do not hand-edit 150 files. Verify with the AC 3 grep. Some files may already differ in
whitespace or ordering — match the existing formatting rather than reflowing, so the diff stays
reviewable as "one line per file".

### T10.2 — An audit for other unscoped destructive cleanups
_Boundary:_ `apps/api/src/__tests__` · _Depends:_ T10.1

`refine-contact.test.ts` was not special — it was just the one we caught. Grep the directory for
`.delete(` calls with no `.where(` and report every one. **Report, do not fix**: some may be
deliberate on genuinely test-only tables. A table that is a ledger, a queue, or an idempotency
backstop is not test-only, and each finding needs a judgement call.

## Done when

Four criteria pass, the AC 3 grep is empty, the suite is green with and without an override, and
T10.2's audit is reported.

## Implementation Notes

_(filled in during build)_
