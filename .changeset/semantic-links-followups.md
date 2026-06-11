---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Semantic links follow-ups: the hosted answer page and cross-device identity.

**Hosted answer page** — a semantic link with no landing page of its own can
point at the engine: `href={HOSTED_ANSWER_HREF}` (new in `@hogsend/email`)
resolves at send time to `GET /v1/t/a/:linkId`, a minimal engine-served page
that confirms the recorded answer and offers a free-text box. Submissions
ingest as `<event>.comment` (one per send + event, `semc:` idempotency key) —
a real consumer event journeys can wait on and destinations receive. The
scaffold's `feedback-checkin` example now lands there by default.

**Cross-device identity (`hs_t`)** — opt-in via `TRACKING_IDENTITY_TOKEN=true`:
tracked-link redirects append a one-hour identity token to the destination
URL; the landing site exchanges it at the new `POST /v1/t/identify` for the
distinct id and calls `posthog.identify`, merging the email click with the
web session. Tokens are AES-256-GCM **encrypted** with `BETTER_AUTH_SECRET`
(a distinct id can be an email address — nothing readable travels in a URL,
history entry, or referrer). New exports: `generateIdentityToken`,
`validateIdentityToken`, `InvalidIdentityTokenError`.
