---
"@hogsend/engine": minor
---

The browser-reachable ingest routes (`/v1/events`, `/v1/lists`, `/v1/feed`, `/v1/flags`, the `/v1/contacts` upsert, `/v1/contacts/me`, `/v1/accounts/me`, `/v1/accounts/link-url`, `/v1/referrals/me`) are now rate-limited after auth and scope: 3000 requests per minute per secret key, and 1000 per minute per publishable key per client IP, so one visitor cannot spend a site's shared `pk_` budget. Configure with the new optional `INGEST_RATE_LIMIT_MAX`, `INGEST_PUBLIC_RATE_LIMIT_MAX` and `INGEST_RATE_LIMIT_WINDOW_MS`; the `/v1/emails` budget (still 30/min) is now configurable with `EMAIL_RATE_LIMIT_MAX`. Requests that fail auth spend no budget.

Every rate-limited response (admin, emails, ingest) now carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until the window frees a slot, read from the oldest request in it) and `RateLimit-Policy` (`<limit>;w=<seconds>`) alongside the existing `X-RateLimit-*` pair, and `Retry-After` on a `429` now reports the real wait instead of the full window. CORS exposes these headers, so browser code can read them. A request matched by two overlapping guards is counted once.

New `POST /v1/admin/api-keys/:id/rotate` mints a replacement key with the same name, scopes, key class and Origin allowlist, and expires the old key after a grace period (`gracePeriodSeconds`, default 24 hours, `0` to retire it at once). Revoking or rotating a key now evicts it from the auth cache on the instance that handled the request, so it is refused there immediately.
