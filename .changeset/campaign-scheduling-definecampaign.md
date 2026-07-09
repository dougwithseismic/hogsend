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

Campaigns grow up into schedulable, code-first broadcasts.

- **`sendAt` scheduling** — `POST /v1/campaigns` accepts a future ISO instant; the campaign is created `scheduled` and delivered by a punctual Hatchet scheduled run, with the reaper cron promoting any due-but-unfired row as backstop. A `sendAt` more than 60s in the past is rejected.
- **`defineCampaign()`** — a broadcast as a committed file. The worker's boot reconciler upserts each definition (keyed `campaign-def:<id>`): future `sendAt` schedules, edits to a still-`scheduled` campaign sync on redeploy (moving `sendAt` re-schedules), a stale `sendAt` at first deploy is marked `expired` (never a surprise blast, grace window `CAMPAIGN_DEFINE_GRACE_MS` default 1h), and a `sent` campaign is retired — redeploys no-op. Wire via `createHogsendClient({ campaigns })`.
- **Cancel** — `POST /v1/campaigns/{id}/cancel` cancels a `scheduled`/`queued`/`sending` campaign. A mid-send cancel stops at the next chunk boundary; completion uses a CAS so a cancel racing the final chunk is never overwritten. New statuses: `scheduled`, `canceled`, `expired` (db migration 0036 adds `scheduled_at`/`canceled_at`).
- **List** — `GET /v1/campaigns?status=&limit=&offset=` (newest first, `hasMore`).
- **Studio** — new Campaigns view (admin routes `GET/POST /v1/admin/campaigns...`): statuses, counts, scheduled-for, cancel.
- **SDK** — `hs.campaigns.send({ sendAt, idempotencyKey })` (the key was previously accepted by the route but dropped by the SDK), `hs.campaigns.list()`, `hs.campaigns.cancel(id)`.
- **CLI** — `hogsend campaigns send --at <iso> --idempotency-key <k>`, `campaigns list --status`, `campaigns cancel <id>`.
- **Fixes** — the route/reaper enqueued sends with `.run()` (which waits for the whole blast to finish inside the request / cron timeout); now `runNoWait()`. The keyed create's `ON CONFLICT` now carries the partial-index predicate (`WHERE idempotency_key IS NOT NULL`) — without it Postgres rejected the insert (42P10).
