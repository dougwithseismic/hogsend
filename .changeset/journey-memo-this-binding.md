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

fix(engine): preserve Hatchet `this` binding in the journey side-effect memoize.

`createMemoize` extracted Hatchet's `memo` into a variable and called it unbound
(`const memo = ctx.memo; memo(fn, deps)`). The SDK's `memo` body opens with
`this.throwIfCancelled()` and reads other `this`-bound fields, so the unbound
call threw `Cannot read properties of undefined (reading 'throwIfCancelled')` —
crashing EVERY journey side effect (`sendEmail` / `sendConnectorAction` /
`ctx.trigger`) the moment an eviction-capable engine (hatchet-lite ≥ v0.80.0)
made `supportsEviction === true`. Tests stub `memo` as a plain arrow fn and CI's
hatchet-lite reports `supportsEviction: false`, so the buggy path was never
exercised. Fixed by invoking `ctx.memo(fn, deps)` directly; added a regression
test whose stub `memo` is a method that touches `this`.
