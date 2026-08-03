---
"@hogsend/engine": minor
"@hogsend/attribution": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/js": minor
"@hogsend/mcp": minor
"@hogsend/plugin-apollo": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-meta-capi": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-telegram": minor
"@hogsend/plugin-twilio": minor
"@hogsend/react": minor
"@hogsend/sms": minor
"@hogsend/studio": minor
"@hogsend/testing": minor
"@hogsend/video": minor
"hogsend": minor
---

`hogsend login` now opens your browser at the approval page with the code
prefilled, so approving is one click. The code and a bare URL are still always
printed — a headless machine, an SSH session, or `--no-browser` completes the
same flow by hand, and a failed browser open never fails the login. The cloud
approve page renders the code as an eight-box segmented input: prefilled from
the link, paste-aware (dashed `XXXX-XXXX` or bare), fully keyboard-navigable,
and screen-reader labelled per character.
