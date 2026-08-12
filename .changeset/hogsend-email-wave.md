---
"@hogsend/plugin-hogsend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"create-hogsend": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
"@hogsend/client": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/attribution": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/js": minor
"@hogsend/mcp": minor
"@hogsend/plugin-apollo": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-meta-capi": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-telegram": minor
"@hogsend/plugin-twilio": minor
"@hogsend/react": minor
"@hogsend/sms": minor
"@hogsend/testing": minor
"@hogsend/video": minor
"hogsend": minor
---

Hogsend Email — a managed sending path that needs no email provider of your own.

`@hogsend/plugin-hogsend` is new: an `EmailProvider` that sends over the Hogsend
relay, so an instance can send with no `RESEND_API_KEY` and no AWS account. One
TXT record verifies a domain instead of three CNAMEs. Set `EMAIL_PROVIDER=hogsend`.

Replies are now a first-class signal. A reply to journey mail arrives as
`email.replied` on the outbound spine, so a journey can wait on it and branch on
whether a human actually answered. Forwarding to a human address is mandatory
wherever inbound is enabled — receiving a customer's reply into a database
nobody reads is worse than not receiving it. A failed forward is recorded rather
than raised, so it never costs you the event. Auto-responders are stored and
forwarded but never emitted, so an out-of-office cannot advance a journey or
start a mail loop.

Fixes worth calling out:

- **Attachments were corrupted in transit.** Binary files sent through the
  managed path had every byte above 127 replaced, destroying any PDF, image or
  archive while plain-text attachments survived. Measured against real SES and
  fixed; attachments now arrive byte-identical.
- **A redelivered bounce was counted twice.** Bounce notifications are
  at-least-once, so the same bounce could advance the suppression counter more
  than once and eventually suppress a deliverable address. Counting and the
  outbound `email.bounced` emit now happen at most once per bounce.
- **`@hono/zod-openapi` is pinned to 1.4.0.** Version 1.5.2 ships broken type
  declarations that make a fresh scaffold fail `check-types` with 33 errors
  inside the engine, none of them yours. Remove the pin once upstream fixes it.
