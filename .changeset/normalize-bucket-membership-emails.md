---
"@hogsend/engine": patch
"@hogsend/core": patch
"@hogsend/email": patch
"@hogsend/db": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/js": patch
"@hogsend/react": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

`bucket_memberships.userEmail` is now normalized (trim + lowercase) at every write site — the realtime join, the reconcile cron, and the backfill task — and migration 0043 backfills existing rows (`UPDATE … WHERE user_email IS DISTINCT FROM lower(trim(user_email))`, a no-op for already-clean rows).

Previously the realtime join wrote the email verbatim from the raw event payload, so a mixed-case membership email could case-miss its normalized `email_preferences` row — the reason every read site (campaign resolvers, suppression pre-filters) carried defensive `lower(trim(…))` joins (audience-model.md wart #1). Those read-side defenses are retained for one release as belt-and-braces and can then be stripped. The emitted `bucket:entered`/`bucket:left` events and the fast-expiry timer payload now carry the normalized address too.
