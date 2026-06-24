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
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

create-hogsend: repair the pnpm/yarn admin-create crash + onboarding UX pass.

The scaffold's Studio-admin step (and the `studio:admin` package.json script) ran
`node node_modules/.bin/hogsend …`, but under pnpm/yarn that bin is a POSIX shell
shim — pointing `node` at it parsed shell as JavaScript and crashed with
`SyntaxError: missing ) after argument list`. Both call sites now target the CLI's
real ESM entry `node_modules/@hogsend/cli/dist/bin.js`, which resolves identically
on npm/pnpm/yarn/bun. Plus a UX pass on the creator: a welcome banner, a
dependency-free spinner on the silent Hatchet-token wait, and `hogsend connect
posthog` surfaced as a guided post-deploy step (shown even when PostHog is chosen
without a pasted key).

The rest of the `@hogsend/*` line moves with this patch to stay on a single
engine version line (no code changes outside create-hogsend).
