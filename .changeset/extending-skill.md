---
"@hogsend/cli": patch
---

Ship a new `hogsend-extending` skill: how to extend a Hogsend app beyond
journeys/emails/buckets — swap the email or analytics provider behind its
engine-owned contract (`EmailProvider` / `PostHogService`), wire an outbound
integration (Slack, a CRM, Stripe) as plain code called from a journey, and when
to publish a `@hogsend/plugin-*` package. The new skill also rides the
`create-hogsend` template (synced from `packages/cli/skills/`), so fresh
scaffolds ship it.
