---
"@hogsend/plugin-resend": patch
---

Sanitize Resend tag names/values to the provider's allowed charset (ASCII letters, numbers, underscores, dashes). The engine's neutral tags carry journey names ("Docs Subscriber") and slashed template keys ("docs/welcome"), which Resend rejected with a validation error — failing every journey email send that used them.
