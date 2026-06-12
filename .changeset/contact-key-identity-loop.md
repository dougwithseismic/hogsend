---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"hogsend": minor
---

Close the analytics identity loop: `POST /v1/events` now returns `contactKey` —
the contact's canonical key (`external_id ?? anonymous_id ?? id`), the same key
outbound destinations emit as `userId` and `hs_t` identity tokens resolve to —
so a consumer site can `identify()` its analytics session against the contact
without any PII round-trip.

To make that key safe to circulate, identity resolution now round-trips it:
`findByKey` falls back to the contact row id for external-kind lookups (an
email-only contact's canonical key IS its row id), and a merge records the
email-only loser's row-id key as an external alias — so a key that left the
system (Hatchet payloads, destination `userId`s, `hs_t` stitches, forwarded
PostHog webhooks) always resolves back to the same live contact instead of
minting a duplicate. (The full engine line rides together per release
discipline.)
