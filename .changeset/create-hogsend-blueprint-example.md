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

Journey Blueprints example content for scaffolded apps.

- New vendored skill `hogsend-authoring-journey-blueprints` (`packages/cli/skills/`, synced into every scaffold's `.claude/skills/`) — teaches an agent how to create/validate/enable a blueprint via the MCP tools, with the full node/edge vocabulary reference (and what's excluded from v1: `digest`/`sleepUntil`/`capture`/`unknown`).
- New `pnpm seed:example-blueprint` script in the scaffold — seeds one example Journey Blueprint (a JSON-authored companion to the `welcome` code journey, same primitives) so a fresh app has one to look at in Studio → Journeys immediately, without needing an agent/API call first.
