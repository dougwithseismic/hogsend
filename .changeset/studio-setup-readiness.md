---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Studio: a non-blocking setup checklist, and stop the domain page erroring without a Resend key.

Opening Studio with no (or a send-only) email provider key made `GET /v1/admin/domain`
return a 502 — "domains request to provider resend failed: … API key is invalid" — which
the Setup view rendered as a scary error. A permission-denied (401/403) from the provider's
domains API is a CONFIGURATION state, not a server error, so it now degrades gracefully:
the domain status service catches it, engages the same warn-once + back-off the per-send
path already uses, and returns a `200` with `status: null`. Transient failures (network/5xx)
still surface as `502`.

On top of that, a new `GET /v1/admin/readiness` endpoint reports per-area setup state
(Studio admin, Hatchet, email provider key, data-plane API key, sending domain, PostHog) as
`ok` / `action` / `optional`, and the Studio Setup page renders it as a non-blocking
checklist above the sending-domain section. Nothing gates the UI: while it loads it shows a
skeleton, and any probe failure degrades a single row rather than the page.

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine version
line.
