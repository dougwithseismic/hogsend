---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/plugin-resend": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

feat(email): provider-neutral EmailEvent + HTML-only send wire

The breaking contract change that makes "the EmailProvider is the swappable
wire" actually true. The provider contract in `@hogsend/core` no longer
traffics in Resend's wire shapes.

What changed (compile-caught, plus one deprecated alias for handler bodies):

- **`EmailEvent` replaces the Resend-shaped webhook union.**
  `verifyWebhook`/`parseWebhook` now return a provider-neutral `EmailEvent`
  (`{ type, messageId, recipients, occurredAt, bounce?, click?, raw }`,
  `email.` event-type prefix kept). `verifyWebhook` MAY be async. New
  `WebhookHandshakeSignal` lets a provider 200 a non-status handshake
  (SNS confirm, Postmark subscription change) without the route sniffing the
  body.
- **HTML-only send wire.** `SendEmailOptions`/`BatchEmailItem` drop
  `react?: ReactElement` — `html` is now required, `text` optional. The engine
  ALWAYS renders React → HTML itself before `provider.send`. React Email stays
  first-class for template authoring AND Studio preview; only the provider wire
  is HTML. `@hogsend/core` no longer depends on React.
- **Neutral tagging.** The wire `tags: {name,value}[]` becomes `tag?: string` +
  `metadata?: Record<string,string>`. The higher-level engine send API
  (`EmailServiceSendOptions.tags`, `POST /v1/emails`) KEEPS `tags` and the
  mailer translates it.
- **Bounce normalization + suppression.** `dispatchWebhook` reads `EmailEvent`
  fields and persists `bounce.class → bounceType`, `bounce.reason →
  bounceReason`. Auto-suppression now fires ONLY on `class === 'permanent'`;
  transient/soft bounces are RECORDED as `email.bounced` (class `transient`) but
  do NOT increment the suppression counter — the old `delivery_delayed` no-op is
  gone. `handleBounce`/`handleComplaint` iterate ALL `event.recipients`
  (de-duped, capped at 100 to avoid a fan-out mass-suppression).
- **Per-provider secrets.** The mailer-level `EmailServiceConfig.webhookSecret`
  hard-gate is removed; each provider owns its own webhook secret at
  construction. The webhook route resolves the provider, verifies, and hands
  `handleWebhook(event, providerId)` an already-verified `EmailEvent`.
- **Tracking sovereignty.** At boot, if the active provider declares
  `capabilities.nativeTracking: true` (Resend), the engine logs a WARN that
  account-level native tracking must be disabled (first-party is the source of
  truth). The outbound-echo suppression for provider open/click is retained.

**Escape hatch (one minor):** `LegacyResendWebhookEvent` (= the frozen Resend
union) is shipped `@deprecated`. A `webhookHandler` body that still reads the
old nested shape can cast `event.raw as LegacyResendWebhookEvent` while
migrating to `EmailEvent` fields (`event.messageId`, `event.bounce`,
`event.recipients`). The old `WebhookEvent`/`WebhookEventType` exports remain
`@deprecated` for one minor and are removed the following minor.
