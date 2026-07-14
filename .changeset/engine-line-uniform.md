---
"@hogsend/attribution": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"hogsend": patch
"@hogsend/js": patch
"@hogsend/mcp": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-meta-capi": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"@hogsend/plugin-twilio": patch
"@hogsend/react": patch
"@hogsend/sms": patch
"create-hogsend": patch
---

Keep the engine version line uniform: bump every engine-line package (and the
`create-hogsend` scaffolder) alongside the Studio docs-link + Deals copy fix, so
all `@hogsend/*` publish on one version and the scaffold's `^{{ENGINE_VERSION}}`
caret pins stay aligned.
