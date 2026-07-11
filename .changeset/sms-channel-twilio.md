---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-twilio": minor
"@hogsend/sms": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

First-class SMS channel, mirroring the email architecture.

- New `SmsProvider` contract in `@hogsend/core` (`defineSmsProvider`) — a dumb plain-text `send` + normalized-webhook (`SmsEvent`) wire; all preference/suppression/render/STOP logic lives in the engine.
- New `@hogsend/sms` package: SMS templates authored as React components rendered to plain text (`renderSmsToText`), an augmentable `SmsTemplateRegistryMap`, and a GSM-7/UCS-2 segment counter.
- New `@hogsend/plugin-twilio` (reference provider): send with retry + Twilio error classification, and `X-Twilio-Signature` webhook verification + inbound normalization. Opt-in via `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + a sender; with no provider configured the SMS service is an inert stub and `sendSms` throws, so existing deploys are unaffected.
- Engine: `SmsProviderRegistry`, env preset, the engine-owned `createTrackedSmsSender` (idempotency short-circuit, dual-track suppression, SMS frequency cap, STOP footer, test-mode redirect), a replay-safe `sendSms()` for journeys (disjoint `smsSend` key kind), `POST /v1/webhooks/sms/:providerId` (delivery-status callbacks + inbound STOP/START/HELP), `ctx.history.sms`, and `sms.sent`/`sms.delivered`/`sms.failed` on the outbound catalog.
- DB: `sms_sends`, `sms_suppressions`, and a `contacts.phone` identity column.
- Full TCPA/CTIA opt-out: an inbound STOP suppresses the phone in both the phone-keyed `sms_suppressions` table and the `sms` channel category on `email_preferences` (emitting `contact.unsubscribed`); START resubscribes.
