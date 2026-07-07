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

Harden long-running journeys against two narrow strand windows (both distinct from the recovery-first fix in the previous release).

- **Durable-wait resumes survive a redeploy's slot saturation.** The journey task now sets `scheduleTimeout: "15m"` (the SDK default is ~5m). When a durable-wait resume is re-queued during a deploy and every worker slot is momentarily busy, the tighter default could cancel the resume in the queue and strand the enrollment in `waiting`; 15m gives it head-room to land on a freed slot. This adds no replay path — it is pure queue head-room.
- **A transient DB error while resolving the enrollee's timezone no longer strands the row.** The pre-`run()` timezone lookup fetches the contact row and PostHog person props concurrently; the PostHog leg already swallowed errors but the contact read did not, so a blip there rejected out of the task *before* the try/catch and left the just-inserted `active` row unhandled. The contact read now falls through to the client-default timezone, mirroring the PostHog leg.

Journey `retries` are intentionally left at `0`: a retry replays `run()` from the top, and the tracked mailer / connector delivery is "missed > doubled" (it re-drives a `queued` row and voids the idempotency key of a failed send), so enabling retries would re-deliver any message whose `provider.send()` had already gone out before its durable status flip committed. Making sends provider-idempotent is a prerequisite and is tracked separately.
