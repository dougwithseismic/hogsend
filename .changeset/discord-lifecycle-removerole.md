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
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

feat(plugin-discord): `removeRole` outbound action for tenure ladders.

Adds a `removeRole` action mirroring `grantRole` (bot-REST `DELETE
.../roles/{roleId}`, idempotent, soft-fails on an unresolved member or a
permission/hierarchy 403) so journeys can demote as well as promote — e.g. a
Stranger → Piglet → Hog member lifecycle (drop Stranger on `/link`, drop Piglet
on graduating to Hog after a 7-day tenure + a message). The rest of the engine
line rides the version bump.
