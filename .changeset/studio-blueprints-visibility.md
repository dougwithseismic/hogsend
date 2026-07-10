---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/email": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Journey Blueprints are now visible in Studio, colocated with code-defined journeys.

- The `/journeys` list merges in blueprint rows alongside `defineJourney` journeys — a Kind badge (Code/Blueprint) tells them apart, and blueprint rows carry their own three-state status (draft/enabled/disabled).
- A new blueprint detail page renders the same flow-graph view as a code journey — a blueprint's `GET /:id/graph` is byte-identical in shape to the code-journey route, so the existing renderer needed no changes, plus a definition card and a recent-instances table.
- View + enable/disable only for now — blueprints are still authored via MCP or the admin API, not from Studio (no visual graph editor yet).

No migrations; API changes are additive.
