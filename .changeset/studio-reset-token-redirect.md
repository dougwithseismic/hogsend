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
"hogsend": patch
---

Fix the Studio password-reset link landing on the login card instead of the reset form. The engine's bare `/studio` → `/studio/` redirect dropped the query string, losing better-auth's `?token=…`; the redirect now preserves it, and the Studio's reset redirect targets `/studio/` directly so the link skips the hop entirely. (The full engine line rides together per release discipline.)
