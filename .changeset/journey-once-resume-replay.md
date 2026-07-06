---
"@hogsend/engine": patch
"@hogsend/cli": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Fix: multi-step `once` journeys silently stalling after their first durable wait.

On an eviction-capable Hatchet engine (hatchet-lite >= v0.80.0) every `ctx.sleep` / `ctx.waitForEvent` evicts the durable task and **replays the journey `fn` from the top** on resume. The enrollment guards (`entryLimit`, email-preference, `trigger.where`, `enabled` / admin-disable, active-state) ran at the top of `fn` **before** the replay-recovery lookup by `hatchetRunId`. So on every resume they re-ran against live state — and for `entryLimit: "once"` the entry-limit guard found the row the first entry had created and returned `skipped: already_entered_once`, short-circuiting **before** recovery and `run()`. The journey never advanced past its first wait: it was stranded in `waiting`, and every email / step after the first sleep was silently dropped (no error, no `journey:failed` — nothing sweeps a stuck `waiting` row). Multi-step `once` journeys (welcome series, conversion nudges) therefore stopped completing whenever a worker redeploy or eviction landed in a wait window; short / `unlimited` journeys were unaffected.

The recovery lookup now runs **first**: a resume recovered by `hatchetRunId` reuses its enrollment and bypasses the entry-eligibility guards (a resume is not an entry), while those guards run only on the genuinely-new-enrollment path. The same guards that also affected `once_per_period` (wait shorter than the period) and unsubscribe-during-a-wait are fixed by the same reorder. Sends inside `run` still re-check subscription (`ctx.guard.isSubscribed()`), and the tracked mailer enforces suppression at send time, so bypassing the entry-time preference gate on a resume never emails an unsubscriber. Exactly-once is preserved: a recovered resume keeps the same `stateId` / run-anchored idempotency keys, so a replayed pre-wait send dedups via the existing unique-index backstop. Covered by a new regression test that evicts a `once` journey at its first sleep, replays from the top, and asserts it resumes and completes with no duplicate send.
