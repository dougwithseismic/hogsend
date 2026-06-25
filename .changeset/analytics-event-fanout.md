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

feat(engine): fan ingested events out to PostHog + fix Discord identity direction

Mirror every ingested event into the active analytics provider from the ingest
spine, keyed to the resolved canonical contact key. Opt-in via
`analytics.eventMirror` (or the `ANALYTICS_EVENT_MIRROR` env override), default
off. Excludes `source: "posthog"` events (echo-loop guard) and supports
`allow`/`deny` event-name filters. Fires once on the fresh-insert side of the
ingest idempotency guard, so retries never double-capture and journeys never
call it.

Discord inbound transforms no longer mint `userId: "discord:<id>"` — a pre-link
member is anonymous (keyed by the `discord_id` column), so a later `/link`
merges it into the email/web contact in the correct direction (`$create_alias`
folds the Discord person onto the canonical one). Each inbound event now carries
the actor's own snowflake in its properties (`authorId` / `reactorId` /
`memberId`), so role grants and DMs fire for members who have not linked yet.

Widen the connector-action contact resolver to also match `anonymous_id` and the
uuid `id` column (uuid-shape-gated to avoid an invalid-uuid cast), so
`member: user.id` resolves any canonical-key form for outbound actions.
