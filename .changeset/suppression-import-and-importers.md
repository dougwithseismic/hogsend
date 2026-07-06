---
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/client": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Bulk suppression-list import + migration importer CLI.

**Engine — `POST /v1/admin/suppressions/import`** (+ `GET /v1/admin/suppressions/import/{jobId}`): async bulk import of unsubscribes / bounces / spam complaints via a new `import-suppressions` Hatchet task (CSV or JSON, batches of 500, `import_jobs` lifecycle, errors capped at 100). Rows are `email` (required), `reason` (`unsubscribed` | `bounced` | `complained`, default `unsubscribed`), `externalId` (optional), mapped onto the existing `email_preferences` semantics — no schema change: `unsubscribed` → `unsubscribed_all`, `bounced` → `suppressed` + `bounce_count = GREATEST(bounce_count, 1)` (idempotent re-runs) + bounce timestamps, `complained` → `suppressed` with the bounce count untouched. Writes go through the single `upsertEmailPreference` choke point, which gains an `emitOutbound` opt-out (default `true`; the import passes `false`) so a historical import does not fan out per-row `contact.unsubscribed` outbound events.

**Behavior change — `POST /v1/admin/contacts/import` no longer awaits the task run.** The route previously `await`ed `importContactsTask.run(...)` to completion before returning its 202, defeating the async job + status-poll contract on large imports. Both import routes now enqueue with `runNoWait()` fire-and-forget: the 202 means "queued", and a failed enqueue marks the job row `failed` (with the error recorded) so status pollers get a terminal state. Both routes also cap `data` at 4MB — the Hatchet gRPC message ceiling a bigger payload could never clear anyway.

**Send-time suppression gate aggregates per address.** `checkSuppression` now reads every `email_preferences` row for the recipient address (the PK is `(user_id, email)`, so a suppression imported before the contact existed lives on a different row than later interactive writes) — any suppressed / unsubscribed-all signal on any row blocks the send, and category maps merge with explicit false winning.

**CLI — new `hogsend import` command** (`@hogsend/cli`): migrates contacts *and* suppression state into a running instance over the admin API, chunking large inputs into one import job per 5,000 rows and polling each to completion. `hogsend import csv --file <path> [--suppressions]` for generic header CSVs; `hogsend import loops --csv <audience.csv> [--api-key] [--check-suppressions]` for the Loops dashboard export (typed custom properties via the Loops API; per-contact suppression lookups at 10 req/s, imported as reason `bounced` since Loops merges bounces + complaints); `hogsend import customerio --app-key <key> [--region us|eu] [--segment <id>] [--esp-suppressions]` drives the Customer.io App API async people export end-to-end and optionally imports the ESP bounce/spam-report lists. Source-platform requests are rate-limited (10 req/s) with retry-on-429 backoff. Job polling aborts with an error (naming the job id) after 10 minutes without progress instead of hanging forever; the Loops suppression check aborts on auth/terminal errors rather than silently importing zero suppressions; the Customer.io export download inflates gzipped files.

Other engine-line packages ride along to keep the version line uniform.
