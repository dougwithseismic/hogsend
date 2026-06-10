---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
---

First-run experience hardening, found by dogfooding a fresh create-hogsend app:

- `/v1/health` gains a non-breaking `activity` section (24h failed/completed journeys, failed/sent emails) so silent failures are visible; `check-alerts` now surfaces recent failures even with zero alert rules configured; journey run failures get a proper error log line.
- First boot with an empty `api_keys` table mints an ingest-scoped key and prints it once to the deploy log (opt out with `HOGSEND_BOOTSTRAP_API_KEY=false`) — a template deploy now has a working data-plane credential out of the box.
- New `hogsend hatchet token` CLI command mints a Hatchet client token headlessly (register/login → tenant → token) against a hatchet-lite instance.
- Restricted email-provider keys (can send, can't read domains) now warn once with a clear explanation that `HOGSEND_TEST_MODE=auto` is inert, then back off for 6h instead of warning every 40s; a real fetched domain status is never overwritten by the fail-open path.
- Worker startup logs the registered journey ids (not just a count) so a stale dev worker is visible at a glance.
- Engine logger's default service name no longer leaks "growthhog-api" into consumer apps.
- New index on `journey_states.updated_at` (migration 0022) backing the health activity counts.
