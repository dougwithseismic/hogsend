---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"create-hogsend": minor
---

Semantic email links — in-email surveys, actions & enrichment.

`EmailAction` (new in `@hogsend/email`) renders an anchor whose click MEANS
something: it carries an event name + scalar properties that the engine lifts
into `tracked_links` at send time (the attributes never reach the inbox) and
emits through the full ingest pipeline at click time. In-email yes/no
questions, NPS scores, and one-tap choices become real events that route to
journeys, persist to `user_events`, and fan out to destinations as the new
`email.action` outbound type (the PostHog preset captures it under the
consumer's event name).

- First answer wins per (send, event name) via a `sem:` idempotency key.
  Answers are confirmed by a deferred task after a ~30s window, so scanner
  click-bursts (SafeLinks/Proofpoint) are judged with the WHOLE burst visible
  — including the scanner's first click — before any answer is recorded.
- `ctx.waitForEvent` now returns `{ timedOut, properties? }` — the matched
  event's payload, so journeys branch on the answer directly (additive,
  backward compatible) — and accepts an optional `lookback` window that checks
  recent `user_events` first, closing the gap where an answer lands between a
  send (or a previous wait) and the wait being established.
- `tracked_links` gains nullable `event`, `event_properties`,
  `semantic_emitted_at` columns (expand-only migration 0023). Same-URL links
  carrying different answers no longer collapse into one row.
- Reserved event namespaces (`email.`/`journey.`/`bucket.`/`contact.`) are
  rejected at send time; semantic properties are scalars-only, size-capped.
- Outbound catalog grows to 14 events (`email.action`) — engine, CLI mirror,
  and client mirror updated. Seeded PostHog destinations subscribe to it, and
  an existing engine-seeded endpoint is reconciled (missing funnel events
  unioned in) at boot. A failed Hatchet publish now rolls back the
  idempotency claim inside `ingestEvent`, so a transient broker error can't
  permanently consume an answer slot.
- Scaffold ships a `feedback-checkin` example (semantic yes/no email + journey
  reacting via `waitForEvent` properties).
