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
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Boot-validate config ids — fail loud on unresolved references instead of silently mis-behaving.

- `ANALYTICS_PROVIDER`: throw at boot when the env-selected id resolves to no registered provider (symmetric with `EMAIL_PROVIDER`); the raw `process.env` read distinguishes an explicit request from the zod default, so a no-analytics deploy still boots.
- `ENABLED_JOURNEYS`: throw at boot on an id that matches no journey, with a did-you-mean. Bucket-reaction journey ids are accepted; validation is skipped when no top-level journeys are injected.
- `JourneyRegistry.register()`: throw on a duplicate journey id instead of silently overwriting (which also double-routed the trigger).
- Template `category`: boot-validate every template's category against the email-list namespace. Unknown → throw; an opt-IN list (`defaultOptIn:false`) excluded via `ENABLED_LISTS` → throw (excluding it un-gates consent at send time — CAN-SPAM/GDPR); an opt-OUT list excluded → warn; reserved built-ins and registered lists → ok.
- `POST /v1/emails`: reject an unknown `category` (the request-time twin of the template-category guard — a caller-supplied category overrides the template's).
