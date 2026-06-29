---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/js": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Keep the engine version line uniform: bump every engine-line package (and the `create-hogsend` scaffolder) alongside the `@hogsend/react` feed-archive fix, so all `@hogsend/*` packages publish on one version and the scaffold's `^{{ENGINE_VERSION}}` caret pins stay aligned.
