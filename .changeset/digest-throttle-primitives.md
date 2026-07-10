---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Digest and throttle land as journey primitives — the "14 events fired, we emailed the user 14 times" class of problem ends here.

- **`ctx.digest({ window, event?, where?, maxEvents?, lookback?, label? })`** — aggregate a burst of events into ONE execution. The first event enrolls the journey; every same-named event landing during the window is absorbed by the active-enrollment guard (stored in `user_events`, spawning no run) and collected at flush. The window deadline and the flushed result are recorded set-once in the journey state row, so a replay-from-top returns the verbatim same event set on ANY engine — even if backfilled events land inside the closed window afterwards. The scan applies the journey's `trigger.where` by default, excludes Studio debug events, re-verifies rows against the strict condition engine, and orders deterministically. Windows go up to 720h and are never tier-gated. "Batch" is deliberately not a primitive: `Object.groupBy(digest.events, …)` in plain TypeScript is the batch recipe, documented in the journeys guide.
- **`ctx.throttle({ limit, window, category?, label? })`** — an advisory "has this user had too many emails already?" branch. Counts the recipient's windowed non-failed `email_sends` (the same count the mailer-level frequency cap enforces on) and RECORDS the verdict set-once per site, so a replay branches identically even though the run's own send has since landed in the counting window. The client-level `frequencyCap` remains the hard send-time backstop.
- **`JourneyMeta.suppress` is now enforced.** It was documented ("minimum time between sends within this journey") but read by nothing. The tracked mailer now skips a journey-bound send (`journey_suppressed`, no provider call, no row) when a non-failed send for the same journey and recipient exists inside the suppress window, across all enrollments; the verdict is recorded for replay stability. Zero disables; transactional and non-journey sends are untouched.
- **Enrollment burst hardening** — two near-simultaneous first events racing enrollment no longer surface the loser as a failed Hatchet run: the insert carries `ON CONFLICT` against the live-enrollment partial unique index and folds to the `already_active` skip.
- **Stranded-waiting detection** — check-alerts now flags `waiting` journey states whose `wait_deadline` or un-flushed digest deadline is more than an hour past due, with an operator hint: such a row silently absorbs every future trigger event for that user+journey until repaired.
- **Studio** — journeys using `ctx.digest` render a digest node in the flow graph (`ctx.throttle` is a decision input, not a node).
- **Foundation** — `ctx.once`'s durable record-once write is now SQL-level first-writer-wins with a read-back, shared by the new primitives via the exported `recordOnce`/`peekRecord`; reserved context namespaces `__digest__`/`__throttle__` join `__once__`.
- **Durable sleeps/timeouts normalized to whole-seconds durations** — `ctx.sleep`/`ctx.sleepUntil`/`ctx.digest` and the `waitForEvent` timeout branches now pass Hatchet a single-unit whole-seconds Go string (`"120s"`) instead of a millisecond number. The SDK renders a raw ms number as a multi-unit string (`"1m59s"`) that some hatchet-lite versions silently fail to honor as a durable sleep condition — the wait resolves instantly with an empty match. This also fixes latent instant-fire on `ctx.sleepUntil` and the `waitForEvent` timeout branch for any non-whole-hour duration.
- **Graceful worker shutdown no longer marks in-flight waiting journeys as failed** — a SIGTERM/`worker.stop()` aborts suspended durable runs so Hatchet can REASSIGN them; the abort surfaced as a journey failure (row → `failed` + `journey:failed`), permanently poisoning the enrollment so the re-dispatched run found a terminal row and never resumed. The engine now detects the SDK abort (by error name/code + the aborted signal) and, when the row is still `waiting`/`active`, leaves it untouched and rethrows — so recovery-first resumes the recorded window after restart. Enrollments now survive a redeploy mid-wait (any `ctx.sleep`/`waitForEvent`/digest window). Pre-existing bug, maximally exposed by digest's long in-process waits.
