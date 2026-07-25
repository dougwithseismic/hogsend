---
"@hogsend/engine": minor
"@hogsend/cli": minor
---

Surface boot-time configuration problems over the wire instead of only on stdout.

The engine now records a deduped, process-global boot diagnostic wherever it
detects a non-fatal misconfiguration: a failed opt-in plugin load, no email
provider, an unsecured contact source, an excluded opt-out list, ignored CRM
sugar, disabled PostHog person reads, and Twilio credentials set without a
sender (that last case previously skipped in complete silence, so the first
symptom was `sendSms` throwing at send time).

`GET /v1/health` reports a warning COUNT — the endpoint is unauthenticated, and
the messages name env vars and absent secrets. Full detail lives behind the
admin-guarded `GET /v1/admin/config`. The count never affects `status`, so a
misconfigured-but-alive deploy still passes its healthcheck.

Worker-process diagnostics ride the existing Redis worker heartbeat: the
collector is per-process and only the API serves HTTP, but the opt-in
credentials are consumed worker-side. `/v1/health` unions by code; the admin
route tags each entry with the process that recorded it.

`hogsend doctor` renders both. Its detail fetch is gated so an admin key
resolved from the ambient environment or a cwd `.env` is never transmitted to a
`--url`-overridden origin.
