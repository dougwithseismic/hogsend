# PRD 09 — Cut the database work on every event and every send

## Goal

A warm ingest (known contact, one `userId`, no groups/conversions/funnels)
costs about 17 database round trips and one Hatchet push before buckets run,
plus 2–4 per candidate bucket (audit, 2026-11-21). Eight of those are no-op
orphan adoption, two of which walk the user's whole event and send history.
Every tracked send seq-scans `email_preferences`. Bring a warm ingest to single
digits and make the per-send preference read an index probe, with numbers.

## Locked decisions

- Index-only migration, house pattern (`CREATE INDEX IF NOT EXISTS`, header
  with the `CONCURRENTLY` recipe for large tables), generated with
  `pnpm db:generate`.
- Do NOT index `contacts.last_seen_at`/`updated_at` (keeps those writes HOT).
- Measure with a query-counting test helper (warm ingest, one send) and record
  before/after in Implementation Notes.

## Acceptance criteria

- WHEN a tracked send reads recipient preferences THEN the plan SHALL use an
  index on `email_preferences(email)` (and `lower(email)` for the campaign
  anti-join), pinned by an EXPLAIN test.
- WHEN a warm ingest runs for a contact with no orphan rows THEN orphan
  adoption SHALL cost at most one indexed existence probe (partial indexes
  `user_events(user_id) WHERE contact_id IS NULL`, same for `email_sends`).
- WHEN an `event` condition is evaluated for `exists`/`not_exists` THEN it
  SHALL use `EXISTS`, and counts SHALL be capped, served by
  `user_events(contact_id, event, occurred_at) WHERE contact_id IS NOT NULL`.
- WHEN `ingestEvent` already holds the `contactId` THEN buckets and the
  tracked mailer SHALL NOT look it up again; `wasMember` reads SHALL be one
  `IN (...)` query; the `last_evaluated_at` bump SHALL skip rows evaluated in
  the last 60 s.
- WHEN exits are checked THEN only `id, journeyId, hatchetRunId` SHALL be
  selected and transition logs written in one insert.
- WHEN a browser (`pk_`) request authenticates THEN the key SHALL come from
  the same 60 s cache and debounced `lastUsedAt` as secret keys.
- WHEN the outbound spine emits THEN subscribed endpoints SHALL come from a
  30 s cache invalidated by the admin webhook routes.
- WHEN the full suite runs THEN it SHALL pass unchanged.

## Tasks

Audit items A1–A4, A6–A9, A11 (indexes only where the read exists). Query
counter helper first, so each step is measured.

## Implementation Notes

### Part A (indexes, adoption gate, event conditions)

Measured by `apps/api/src/__tests__/ingest-hot-path.test.ts` with the
`query-counter.ts` helper (postgres.js `debug` hook, one count per statement
on the wire, `begin`/`commit` included). The test asserts the AFTER numbers
as upper bounds.

| Path | Before | After |
| --- | --- | --- |
| Warm ingest (known contact, one `userId`, no orphans) | 17 | 10 |
| One tracked send | 6 | 6 |

- Warm ingest: the eight unconditional adoption statements are now one
  `select (exists … or exists …)` probe across the five adopted tables. When
  orphans exist, the probe runs and then the same eight statements run, so
  that case costs one more statement than before.
- Tracked send: the count is unchanged, but the preference read is now an
  index probe (`BitmapOr` of `email_preferences_email_idx` and
  `email_preferences_contact_email_idx`) instead of a sequential scan. The
  contact lookup it still does is part B.
- Migration `0075` adds `email_preferences(email)`,
  `email_preferences(lower(email))` (the campaign suppression reads filter on
  `lower(email)`), partial `user_events(user_id)` and `email_sends(user_id)`
  `WHERE contact_id IS NULL`, and partial
  `user_events(contact_id, event, occurred_at) WHERE contact_id IS NOT NULL`.
  Nothing dropped. `user_events_contact_id_idx` is now a prefix of the new
  composite and could go later; `history-contact-id-indexes.test.ts` pins it.
- `event` conditions in `evaluateCondition` go through `eventConditionMatches`:
  `exists`/`not_exists` are one `select exists (…)`, and a count comparison
  counts at most `floor(value) + 1` rows. `evaluateEventCondition` (exact
  count, used by `ctx.history.hasEvent`) is unchanged.
- Single digits for the warm ingest needs part B (contact id threading, exit
  select narrowing) or folding the probe into the contact update.

### Part B (contact id threading, exit narrowing, key and endpoint caches)

Same test file, same counter. The counter now ignores postgres.js's per-new-
connection array-type fetch, which appeared only when the pool happened to open
a connection mid-block.

| Path | Part A | Part B |
| --- | --- | --- |
| Warm ingest (no buckets, no outbound endpoints) | 10 | 10 |
| One tracked send (journey or API path) | 6 | 5 |
| One tracked send handed a fresh `contactId` (campaign path) | 6 | 4 |
| Re-check of N buckets a contact already belongs to | 2N + reads | 1 membership read, no bumps |
| `pk_` request on a warm key | 2 (`select` + `lastUsedAt` update) | 0 |

- Outbound endpoint cache (`lib/outbound-endpoint-cache.ts`): every enabled
  single-tenant endpoint with its `event_types`, filtered in memory per emit.
  30 s TTL (`OUTBOUND_ENDPOINT_CACHE_TTL_MS`, read at emit time, `0` turns it
  off) and a generation counter so a read that started before an
  invalidation can't refill the cache with the pre-write list. Cleared by the
  admin create/update/delete routes and the PostHog destination seed, on the
  instance that made the change only. The worker and other API instances lag
  up to 30 s: a new endpoint misses events in that window; a disabled or
  deleted one is still never sent to, because `deliver-webhook` re-reads the
  endpoint row. Secret rotation does not invalidate (it changes neither
  `disabled` nor `event_types`). `apps/api/vitest.config.ts` sets the TTL to
  `0` because many test files write endpoints straight to the DB.
- `pk_` keys go through `loadApiKey` (`middleware/api-key.ts`), the same 60 s
  cache and 5-minute debounced `lastUsedAt` as secret keys. Before, every
  browser request selected the key and wrote `lastUsedAt`. The trade: a revoked
  or rotated `pk_` key now keeps working on other instances for up to a
  minute, exactly like a secret key.
- Buckets: one `IN (…)` read for every candidate's active membership instead of
  a `findFirst` per candidate; the contact read uses the threaded `contactId`
  instead of `lookupContactIdByKey`; a stable member's `last_evaluated_at` is
  rewritten only when it is older than 60 s. The only reader of that column is
  the reconcile cron's oldest-first cursor on a 5-minute cadence, which a
  minute's lag doesn't reorder.
- Exits select `id, journeyId, hatchetRunId` instead of whole rows and write
  their `end-exited` log rows with one multi-row insert (`logTransitions`).
- The tracked mailer takes an explicit `contactId` option. Only the campaign
  resolvers pass it (they join `contacts` with `deleted_at IS NULL` in the
  same unit of work). Journey sends deliberately do NOT pass the
  enrollment-time contact id: a merge mid-journey would make it stale and the
  send row would be stamped on the merged-away contact. They still pay the
  lookup.
- Not done, for a later row: the warm ingest is still 10. The remaining
  candidates are the `journey_blueprints` trigger lookup (cacheable like the
  endpoints) and folding the orphan probe into the contact update (row 12's
  resolver fast path).
