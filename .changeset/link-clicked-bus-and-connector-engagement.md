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

Managed-link campaigns + connector engagement events.

`link.clicked` is now a first-party bus event: a click on any NON-email managed
link (Discord, SMS, referral, standalone Studio link) re-ingests through the
journey pipeline, so a journey can `trigger` on — or `ctx.waitForEvent` for — a
click of a SPECIFIC managed link (filter by `linkId`/`campaign`). The re-ingest
is gated on `!isBot` (unfurl/prefetch bots that auto-fetch DM'd links are
suppressed) and a personal link's `distinctId` (broadcast/public links carry no
person). The per-hit outbound `link.clicked` webhook and the entire email
branch are unchanged.

`ctx.waitForEvent` gains an optional `where` predicate (the same model as
`trigger.where`) so a journey can await a specific link's click mid-run. It runs
an engine-side durable re-arm loop with a persisted `wait_deadline` (survives
Hatchet replay), gap-proof re-scans, and scalar-narrowed properties; omitting
`where` keeps the exact legacy single-wait. `ctx.history.events` gains an
`event` name filter.

Connector engagement events: the connector transform contract widens to
`IngestEvent | IngestEvent[] | null`, and Discord reactions now fan out into a
reactor-keyed `discord.reaction_added` (carrying the target author for
distinct-people counting) plus, when the message author is known (resolved
cache-only in the gateway worker — no REST), an author-keyed
`discord.reaction_received` powering "your post resonated with N people". Adds
`discord.reaction_removed` and a `grantRole` outbound action for the
community-gamification loop (count an engagement event → grant a role + DM).
