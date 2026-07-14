---
"@hogsend/engine": patch
"@hogsend/attribution": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/core": patch
"@hogsend/db": patch
"@hogsend/email": patch
"@hogsend/js": patch
"@hogsend/mcp": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-meta-capi": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-telegram": patch
"@hogsend/plugin-twilio": patch
"@hogsend/react": patch
"@hogsend/sms": patch
"@hogsend/studio": patch
"hogsend": patch
---

fix(admin): stop the Events feed duplicating a row per matching contact

`GET /v1/admin/events` (and `/:id`) LEFT JOINed `user_events` → `contacts` on
`external_id OR anonymous_id OR id`. Those three key namespaces are each
partial-unique among live rows but NOT guaranteed disjoint _across_ contacts:
when a mis-keyed emitter parks one contact's canonical key in a different
contact's `anonymous_id`, the OR-join matches BOTH contacts and every event for
that `user_id` renders twice — once per contact, with a different resolved
`contactId`/`userEmail` on each copy — while the list `total` (an unjoined
`count`) still says one. Replaced the bare join with a correlated `LATERAL`
that picks exactly ONE live contact, ordered by the same precedence ingest
resolves keys with (`external_id` > `anonymous_id` > `id`), so a row surfaces
once and attributes to the canonical contact. Purely a read/display fix — no
event was ever double-stored.

The rest of the `@hogsend/*` line rides this patch to stay version-uniform.
