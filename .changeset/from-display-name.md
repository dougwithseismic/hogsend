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
"@hogsend/studio": patch
---

Allow a display name in the configured from address: `RESEND_FROM_EMAIL` and `EMAIL_FROM` now accept `Doug at Hogsend <doug@hogsend.com>` as well as a bare address. Sending-domain derivation (test mode, domain status) parses either form.
