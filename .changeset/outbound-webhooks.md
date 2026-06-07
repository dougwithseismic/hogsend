---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

feat: outbound webhooks + integration presets

Adds a Svix-style HMAC-signed outbound webhook stream — a 12-event catalog,
managed endpoints (`/v1/admin/webhooks` CRUD + rotate-secret + test), and
durable delivery (per-endpoint retry/backoff, dead-letter, and a 1-minute
reaper that re-drives due retries and recovers orphaned `sending` rows). The
`hs.webhooks.*` client resource ships with `verifyHogsendWebhook` (svix +
node:crypto fallback), and the CLI gains a `hogsend webhooks` command.

Adds inbound integration presets (Clerk, Supabase `auth.users`, Stripe,
Segment) as `defineWebhookSource` presets, enabled by env. The webhook-source
auth contract is widened to a discriminated union with a fail-closed
`signature` scheme (svix / Stripe `node:crypto` / generic HMAC-hex), and the
route reads the raw body once so signatures verify against the exact bytes.

All engine-line packages move together on the version line so the scaffold's
caret pins keep resolving.
