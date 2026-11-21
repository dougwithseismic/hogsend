# PRD 07 — Fix the quiet correctness bugs the engine audit found

## Goal

The 2026-11-21 engine audit (performance + extensibility, read-only) turned up
a handful of defects that are silent today and get worse with volume. None
needs a design change; each is a small, test-pinned fix. They go before the
performance work because they corrupt data or fail outright, where the
performance items only cost time.

## Locked decisions

- Behaviour-preserving everywhere except the defect itself. No public API
  changes, no migrations.
- One engine patch changeset (plus the uniform-line companion).
- Every fix lands with a regression test that fails on `main`.

## Acceptance criteria

1. **Tracking identity.** WHEN an email sent without a journey and without a
   stamped contact is opened or clicked THEN the re-ingested `email.opened` /
   `email.link_clicked` event SHALL resolve identity from
   `email_sends.user_id`, then the address as an EMAIL key, and SHALL NOT pass
   the address as `userId` (which today can write `external_id = <email>` onto
   an email-only contact and flip its canonical key).
   `resolveEmailSendContext` and `resolveEmailSendContextByMessageId` SHALL use
   the same fallback chain.
2. **Bucket mass expiry.** WHEN more than 65,534 members leave a bucket in one
   reconcile tick THEN `bulkLeave` SHALL process them in bounded chunks (500,
   as `reevalLeaves` already does) and emit per chunk, instead of throwing on
   every tick from the postgres.js parameter limit.
3. **Pools.** WHEN a workflow task runs THEN it SHALL use the shared `getDb()`
   client, not a fresh `createDatabase()` pool that is never ended
   (`bucket-reconcile` ×2 incl. the pre-sleep `bucketExpiryTask`,
   `dispatch-conversion`, `bucket-backfill`, `import-contacts`,
   `import-suppressions`, `crm-reconcile`, `check-alerts`,
   `identity-alias-backfill`, `backfill-contact-id`, `impact-digest`).
4. **Webhook reaper.** WHEN the outbound-webhook reaper finds stuck
   deliveries THEN it SHALL enqueue them with `runNoWait`, not await up to 500
   serial `.run()` calls.
5. **Timeouts.** WHEN the Discord REST action or the Postmark domains client
   calls out THEN the `fetch` SHALL carry an `AbortSignal.timeout`.

## Tasks

1. `lib/tracking-events.ts` fallback chain + test (open and click paths, raw
   send to an email-only contact keeps `external_id` null).
2. `workflows/bucket-reconcile.ts` chunked `bulkLeave`; test with a leaver
   set spanning several chunks.
3. Replace per-run `createDatabase` with `getDb()`; grep guard test so new
   tasks don't regress.
4. `workflows/deliver-webhook.ts` reaper `runNoWait`.
5. `AbortSignal.timeout` in `plugin-discord` REST and `plugin-postmark`
   domains client.

## Implementation Notes

Built on `autopilot/07-audit-correctness`.

- **Tracking identity.** Reproduced on `main`: an open on a raw send to an
  email-only contact set `external_id = <address>`. `EmailSendContext` gains
  `subjectKey` (enrollment key, else `email_sends.user_id`, else null);
  `pushTrackingEvent` re-ingests `userId: subjectKey`, so a bare-address send
  resolves by email. `userId` (display/attribution) keeps its old fallback, so
  outbound payloads and identity tokens are unchanged. Consequence: tracking
  events for a raw send to an unknown address now land on an email-keyed
  contact (canonical key = its uuid) rather than one minted with
  `external_id = <address>`. `tracking-semantic` / `tracking-answer` now look
  answers up through the contact.
- **Bucket mass expiry.** `bulkLeave` loops `bulkLeaveChunk` per 500. Test:
  1,201 expired members leave in one tick with 1,201 `bucket:left` pushes
  (~6 s locally). The 65,534-parameter failure itself isn't reproduced in CI
  (66k emits would take minutes); the chunk boundaries are what's pinned. The
  leaver SELECTs are still unbounded in memory — fine at today's scale, listed
  under PRD 09.
- **Pools.** 11 call sites in 10 workflow files → `getDb()`. Guard test
  `workflows-shared-pool` fails if any workflow calls `createDatabase(`. The
  container still opens its own pool, so a worker holds two (was 2 + one per
  run).
- **Webhook reaper.** `runNoWait`; the test mock forwards `runNoWait` to the
  real delivery body only inside the reaper suite.
- **Timeouts.** 10 s on Discord bot REST and Postmark domains.
- **Dropped: campaign re-drive suppressed rows.** Not a bug. Campaign counts
  are snapshot-based (`stepBaseCounts`), so a re-drive never double-counts. A
  suppressed send deliberately leaves the idempotency key unconsumed so a
  re-subscribed recipient can still be sent to. A re-drive adds a duplicate
  `suppressed` log row, and only after a crash or timeout.
