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

_Filled in after shipping._
