---
"@hogsend/engine": patch
---

Less database work per event, per send and per browser request:

- Outbound webhook emits read the list of enabled endpoints from a 30-second in-process cache instead of querying `webhook_endpoints` on every event. The admin webhook routes and the PostHog destination seed clear it on the instance that made the change; another API instance or the worker picks the change up within 30 seconds. A disabled or deleted endpoint is never delivered to in that window, because delivery re-reads the endpoint first. Set `OUTBOUND_ENDPOINT_CACHE_TTL_MS` to change the window, or `0` to turn the cache off.
- Publishable (`pk_`) keys authenticate from the same 60-second cache as secret keys, and their `lastUsedAt` is written at most every 5 minutes instead of on every request. As with secret keys, a revoked or rotated publishable key stops working on other instances within a minute.
- Bucket checks read every candidate membership in one query instead of one per bucket, reuse the contact id the ingest already resolved, and rewrite a stable member's `last_evaluated_at` at most once a minute.
- Exit checks select only the columns they use and write their journey log rows in one insert.
- Campaign sends pass the recipient's contact id to the mailer, which skips its contact lookup. `emailService.send()` accepts an optional `contactId` for callers that read the contact in the same unit of work.
