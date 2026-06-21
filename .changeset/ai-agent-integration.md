---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

feat: AI agent integration — recent-events history read, AI SDK journeys, and Eve durable churn-save

- **`@hogsend/core` / `@hogsend/engine`**: add `ctx.history.events({ userId, limit?, within? })` — a generic newest-first read of a user's recent events (with `RecentEventsOptions` / `RecentEvent` types), the foundation for assembling agent context bundles.
- **`@hogsend/engine`**: the webhook-source route now resolves a source's auth secret from `process.env[auth.envKey]` when the engine's validated env doesn't declare that key, so a consumer-defined `signature`/`match` webhook source can bring its own secret. Behavior is unchanged for engine presets and stays fail-closed (an unset `signature` secret is still a 401) — this fixes BYO signature sources (e.g. an Eve HITL callback) that previously could not resolve their secret.
- **`create-hogsend`**: a freshly scaffolded app now ships a working Tier-1 AI onboarding journey (`src/agents/` + `ctx.history.events()`-backed user context) and gains `ai` + `@ai-sdk/anthropic`; new docs cover the three AI SDK integration tiers (inline, tools, and Eve durable HITL).

The remaining engine-line packages are version-only bumps to keep the engine release line uniform (the scaffold pins `^ENGINE_VERSION`).
