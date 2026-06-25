---
"@hogsend/engine": minor
"@hogsend/studio": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-telegram": minor
"hogsend": minor
"create-hogsend": minor
---

Studio co-working AI agent (GLM-5.2 via OpenRouter)

Adds an in-Studio co-working agent: a bottom-right chat panel that reads the live
instance (contacts, events, journeys, buckets, sends) and can act through the
existing data plane — every write gated behind a human-in-the-loop confirmation.

- Engine: streaming `POST /v1/admin/agent/chat` (Vercel AI SDK + OpenRouter,
  default model `z-ai/glm-5.2`) under the admin auth/rate-limit/audit stack; the
  OpenRouter key never leaves the server. Read tools auto-run; write tools mint a
  single-use, encrypted, Redis-burned proposal token that only
  `POST /v1/admin/agent/confirm` can execute (idempotent, audited,
  test-mode-aware tier reclassification).
- Studio: launcher → slide-over drawer, multi-chat (localStorage), markdown
  rendering, tool-call cards, a tier-driven confirmation card, and per-message
  edit / rollback / regenerate over a virtualized thread.

Opt-in and fail-closed: with no `OPENROUTER_API_KEY` the panel shows a calm
"not configured" state and the routes 503. The rest of the engine-line packages
move with the engine version line (no functional change in those).
