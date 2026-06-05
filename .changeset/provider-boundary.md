---
"@hogsend/core": minor
"@hogsend/engine": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-posthog": minor
---

Relocate the capability-provider contracts to `@hogsend/core`. The `EmailProvider`
and `PostHogService` interfaces (and their supporting types — `SendEmailOptions`,
`BatchEmailItem`, `SendResult`, `WebhookEvent`, `WebhookEventType`,
`WebhookHandlerMap`, `CaptureOptions`) now live in `@hogsend/core` and are
re-exported from `@hogsend/engine` as the canonical author import. The vendor
plugins (`@hogsend/plugin-resend`, `@hogsend/plugin-posthog`) re-export them
unchanged, so existing imports keep working — no breaking changes. A custom email
provider now implements `import type { EmailProvider } from "@hogsend/engine"`
(the contract no longer lives inside the Resend package). See
`docs/adr/0001-provider-boundary.md`.

Also makes the injected provider/analytics instances load-bearing: a swapped
`opts.analytics` is now honored in journey context, the bucket→PostHog sync, and
worker shutdown (previously these bypassed it via the module singleton), and the
built-in `send-email` task and alert notifications now deliver through the
injected `EmailProvider` instead of constructing a raw Resend client — so a
swapped provider takes effect everywhere. The `send-email` task no longer
double-retries on top of the provider's own retry loop.
