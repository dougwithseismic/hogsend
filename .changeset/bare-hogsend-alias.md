---
"hogsend": patch
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

Claim the bare `hogsend` npm name: a new alias package whose bin forwards to `@hogsend/cli`, so `npx hogsend` / `pnpm dlx hogsend upgrade` work without the scope. `@hogsend/cli` now exports `./bin` (and `./package.json`) to support it.
