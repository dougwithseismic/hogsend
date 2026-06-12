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
"hogsend": minor
"create-hogsend": minor
---

`hogsend connect posthog` — one command wires the whole PostHog loop. The
CLI runs a public-client OAuth flow (PKCE S256, loopback callback, no
client secret; the OAuth server is discovered from your instance's own
PostHog host so the region is always right and self-hosted instances
degrade to the personal-key path), stores the credential encrypted at rest
(new `provider_credentials` table + admin routes; tokens never leave the
server once stored), and provisions the PostHog → Hogsend webhook
destination idempotently (adopts an existing destination instead of
duplicating; refuses when `POSTHOG_WEBHOOK_SECRET` is unset rather than
wiring an unauthenticated endpoint). Person reads prefer the OAuth token
and fall back to `POSTHOG_PERSONAL_API_KEY`; a credential stored at
runtime is picked up by the running api and worker within ~30 seconds, no
restart. (The full engine line rides together per release discipline.)
