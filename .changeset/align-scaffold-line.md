---
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

Align the scaffold-pinned packages to the engine 0.4 line (no functional changes) so a fresh `create-hogsend` install resolves every `@hogsend/*` dependency on one compatible minor. Remember to bump `ENGINE_VERSION` in `packages/create-hogsend/src/template-manifest.ts` to match in the Version PR.
