---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/studio": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"hogsend": patch
"create-hogsend": patch
---

`@hogsend/react`: clean feed-notification truncation + a reveal animation. Long titles and bodies now clamp to a token-driven N-line ellipsis (`--hs-feed-item-title-lines` / `--hs-feed-item-body-lines`, default 2) instead of being ragged-clipped mid-line with shaved descenders; the inline survey block is left untouched. New feed items also fade + lift in as they mount (`--hs-feed-item-enter-ms`), gated behind `prefers-reduced-motion` and kept clear of the swipe-to-archive exit animation.
