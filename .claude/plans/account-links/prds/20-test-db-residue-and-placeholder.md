# PRD 20 — the test suite talks to databases nobody chose

## Goal
Close two shared-state hazards that PRDs 17 and 18 surfaced and neither could fix inside its
boundary: a "placeholder" `DATABASE_URL` that resolves to a REAL unrelated database, and a suite that
seeds rows it never deletes, so tests inherit each other's residue and grow slower forever.

## The evidence (all observed this run, not theorised)

### Hazard 1 — the placeholder is not a placeholder

`apps/api/vitest.config.ts:86` sets `DATABASE_URL: postgresql://test:test@localhost:5432/test`. On a
dev machine, port **5432 hosts an unrelated project's Postgres** (`craig-knight-db` is up on 5432
right now) which **accepts that connection**. The hogsend test database is on **5434**.

So a test that does not override `DATABASE_URL` gets a live connection to a foreign database where
every hogsend table is missing. That is precisely what made PRD 17's failure deterministic:
`SELECT 1` succeeded (`database.status: "up"`, `latencyMs: 19`) while both activity COUNTs errored.
The config's own comment describes an address that is unreachable; it is not.

**This is a known class in this repo.** `REDIS_URL` had no per-file override and silently borrowed
another project's container — the same failure, one port over. A placeholder that happens to be
occupied is worse than a placeholder that refuses, because "connected" is the answer that hides.

### Hazard 2 — cross-file residue, and unbounded growth

- Two `apps/api` files failed in one run and passed in the next on IDENTICAL code:
  `analytics-admin.test.ts` (`expected 409 to be 200`) and
  `posthog-webhook-secret-store.test.ts` (`expected 401 to be 200`). Re-running just those two in
  isolation produced a THIRD, different failure — `analytics-admin > returns the env projection`,
  `webhookSecretConfigured` expected false, received true — whose own comment says it assumes an empty
  derived-secret table that the sibling file had populated.
- The suite seeds contacts it never deletes: **19,376 rows, 17,469 live**. PRD 18's sweep tests cost
  ~20s each because of it and get slower every run. The 90s budget bought roughly 4x, not a fix.
- Two concurrent PROCESSES running `apps/api test` both run the global contact-id sweep and steal each
  other's stamps, making that file's result meaningless when agents run in parallel.

## Locked decisions specific to this PRD
- A placeholder connection string MUST refuse, not connect. If a test does not opt into a real
  database, its DB calls fail fast and loudly rather than silently succeeding against a stranger.
- Tests own their rows. A file that seeds must clean up, or seed under a run-scoped key that a teardown
  can remove.
- Do NOT fix this by serialising the whole suite — it is already 165s, and `webhook-fanout` exists so
  that only files genuinely needing serialisation pay.
- Fixing residue must not mean deleting assertions. If a test depends on an empty table, the fix is to
  make the table empty for it, not to stop checking.

## Acceptance criteria (EARS)

- WHEN a test runs without opting into a real database, any DB call SHALL fail fast with an error
  naming the misconfiguration, and SHALL NOT connect to an unrelated server.
- WHEN the placeholder port is occupied by a foreign service, the suite result SHALL be unchanged —
  no test may pass or fail because of what else is running on the machine.
- WHEN a test file seeds rows, it SHALL remove them, or scope them so a teardown can.
- WHEN `analytics-admin.test.ts` and `posthog-webhook-secret-store.test.ts` run in either order, in
  isolation or under the full suite, both SHALL pass.
- WHEN two processes run `apps/api test` concurrently, the contact-id sweep file SHALL either be safe
  or SHALL fail loudly with a message naming the conflict — never report a misleading green.

## Tasks

### T1 — Make the placeholder refuse
_Boundary:_ `apps/api`
_Depends:_ —

Point the vitest-config placeholder at something that CANNOT be a real server (an unroutable port, or
a deliberately invalid URL), and correct the comment to state what it is and why. Then re-run the full
suite: any test that starts failing was silently depending on the foreign connection, and each one is
a finding — report them, do not paper over them.

Verify with `docker ps` that the chosen port is not in use by anything, and say in the comment that
the check is the point.

### T2 — Fix the derived-secret residue between the two named files
_Boundary:_ `apps/api`
_Depends:_ —

Reproduce the ordering dependency first (run them in both orders, capture the diffs). Then give the
depending test the empty state it assumes — scoped cleanup in `beforeEach`, or a run-scoped key — so
it stops depending on execution order. Do not weaken the `webhookSecretConfigured` assertion; it is
checking a real thing.

PROVE it: run the two files in both orders and in isolation, three times each.

### T3 — Bound the contact seeding
_Boundary:_ `apps/api`
_Depends:_ —

Find the files seeding contacts without teardown (19,376 rows is the symptom) and give them cleanup
scoped to their own keys. Measure a sweep before and after and record both numbers — the PRD 18 budget
was sized to a measurement, and this changes it.

If the durable fix is an engine change (a scope argument on `runContactIdBackfill` so a test can sweep
only its own rows), say so with evidence and STOP — that is a separate PRD, not a drive-by.

### T4 — Guard against concurrent suite processes
_Boundary:_ `apps/api`
_Depends:_ —

Make a second concurrent `apps/api test` detectable rather than silently corrupting: an advisory lock,
a lockfile, or a documented refusal. A misleading green is the failure mode to eliminate — a loud
refusal is an acceptable outcome.

## Seams
None — everything here is local infrastructure.

## Done when
- [ ] The placeholder cannot connect to anything, and its comment says so truthfully.
- [ ] Every test that silently depended on the foreign connection is identified and reported.
- [ ] The two named files pass in both orders, isolated and full-suite, three runs each.
- [ ] Contact seeding is bounded, with before/after sweep timings recorded.
- [ ] A concurrent second suite process cannot produce a misleading green.
- [ ] No assertion was deleted or weakened to reach any of the above.
- [ ] `pnpm lint`
- [ ] `pnpm -C apps/api test`

## Implementation Notes
