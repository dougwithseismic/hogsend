---
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/engine": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Fix scaffolded apps crashing at boot ("Dynamic require of X is not supported") on engine 0.35.0+

engine 0.35.0 added `ai` + `@openrouter/ai-sdk-provider` (for the Studio agent), but the `create-hogsend` template's `package.json` never declared them — so a consumer's tsup (which externalizes everything outside `@hogsend/*`) had no node_modules copy to externalize and instead bundled the CJS `ai` tree (transitively `@vercel/oidc`) into the ESM `dist`, which crashes at module-eval. The template now declares `ai`, `@openrouter/ai-sdk-provider`, plus the two other engine runtime deps that were also missing (`svix`, `picocolors`), so tsup externalizes them and they resolve from node_modules at runtime. `verify-scaffold` now boots the built app (api + worker) to catch this class of bundling regression, which a build-only smoke missed.
