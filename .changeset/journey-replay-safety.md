---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Journeys: exactly-once side effects across a Hatchet durable replay.

Journey `run()` bodies call `sendEmail()`, `ctx.trigger()`, and `sendConnectorAction()` inline between durable waits. Hatchet replays a durable task from the top on worker crash, OOM, or redeploy, so these previously re-fired and could deliver duplicate emails / events / connector messages.

Side effects are now exactly-once with **no journey-authoring change in the common case**. An `AsyncLocalStorage` journey boundary auto-derives a deterministic, branch-stable idempotency key (`workflowRunId : nearest-wait-label : discriminant`) and threads it through the existing `email_sends` / `user_events` unique-index short-circuits, plus a new `connector_deliveries` table (migration `0031`) for Telegram/Discord sends. A Hatchet `memo()` fast path skips the effect entirely before the DB on eviction-capable engines (>= v0.80.0). The one authoring rule (enforced by a loud throw on an intra-run key collision): pass a distinct `idempotencyLabel` when sending the same template, triggering the same event, or running the same connector action more than once in one journey on divergent branches. Adds `ctx.now()` (replay-stable clock) and `ctx.once()` (record-once per enrollment).

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine version line.
