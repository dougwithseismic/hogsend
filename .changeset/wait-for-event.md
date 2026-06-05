---
"@hogsend/engine": minor
"@hogsend/core": minor
---

Add `ctx.waitForEvent({ event, timeout })` — a durable journey primitive that pauses a journey until the enrolled user emits a specific event (or a timeout elapses), then resumes. The wait is user-scoped and forward-looking; an `exitOn` match (or cancellation) during the wait aborts the run cleanly via `JourneyExitedError`, marks the state `"exited"`, and cancels the in-flight Hatchet run so no post-wait side effects fire. Also hardens `exitOn` to cancel suspended `ctx.sleep`/`ctx.waitForEvent` runs instead of letting them resume after exit.
