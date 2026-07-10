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

Multi-step campaigns: email waves (phase 1 of `docs/campaign-steps-spec.md`).

A journey runs code per person; a campaign runs waves per audience. Campaign steps are data, executed as set operations over the audience — a 3-step campaign to 100k people costs ~3 durable runs, not 100k.

- **Steps authoring** — `defineCampaign({ steps: [...] })` with `step.send({ template, props?, subject?, from?, where? })` and `step.wait(duration)` (exported from `@hogsend/engine`). The legacy single-template form is unchanged and compiles to one send step. Validation at definition time: 1–10 steps, first must be a send, no trailing wait, waits ≥ 5 minutes, `where` only on send steps after the first, and every `where` condition must be one the wave runtime can compile to bulk SQL (`property`/`composite`/event-`count` are rejected at deploy, not mid-campaign).
- **Cohort builder** — `where: (c) => [c.notOpened(), c.notFiredEvent(Events.X)]` with `opened`/`notOpened`/`clicked`/`notClicked(template?)` (first-party engagement over THIS campaign's prior sends), `firedEvent`/`notFiredEvent(event)` (since the campaign started), `linked`/`notLinked(connector)` (v1: `"discord"` via `contacts.discordId`). Conditions normalize to plain `ConditionEval` data at definition time; new core condition type `channel_identity`.
- **Wave runtime** — the audience is resolved once and anchored into the new `campaign_recipients` cohort ledger at wave 0; later waves qualify from the cohort ∩ the step's conditions ∩ a fresh suppression/unsubscribe/erased-contact re-check (suppression is never snapshotted). Waits park the row in the new non-terminal `waiting` status (`nextStepAt`, punctual scheduled resume + reaper backstop, mirror early-fire guard). Multi-step sends carry step-scoped idempotency keys `campaign:<id>:<step>:<email>`; single-step campaigns keep the legacy key byte-for-byte. Crash/retry resumes at `currentStep` with counts seeded from a wave-boundary snapshot — no double-sends, no double-counting. Cancel works from `waiting` too. DB migration 0037.
- **Stats + Studio** — `GET /v1/admin/campaigns/:id/stats` gains a per-step breakdown; campaign responses gain `steps`/`currentStep`/`nextStepAt`. The Studio campaign detail page renders a per-step funnel (condition chips, wait separators, current-step highlight) and a `waiting` chip with a next-wave countdown.

`POST /v1/campaigns` is unchanged (single-template; API/Studio multi-step authoring is a later phase). Channel steps (`step.discord.post`/`.dm`) and timezone-bucketed local-time delivery are phases 2–3 of the spec.
