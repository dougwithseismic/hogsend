---
"@hogsend/engine": patch
---

Opens and clicks on a journeyless email no longer write the recipient's address into the contact's `external_id`. The tracking re-ingest now keys on the send's recorded `user_id` (or the enrollment's), and falls back to the address as an email key. Bucket max-dwell expiry leaves members in chunks of 500, so a mass expiry no longer throws on every reconcile tick. Workflow tasks share the process database pool instead of opening a new one per run. The outbound-webhook reaper enqueues re-drives instead of awaiting each delivery.
