---
"@hogsend/core": minor
"@hogsend/voice": minor
"@hogsend/plugin-vapi": minor
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/studio": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/js": minor
"@hogsend/mcp": minor
"@hogsend/plugin-discord": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-telegram": minor
"@hogsend/plugin-twilio": minor
"@hogsend/react": minor
"@hogsend/sms": minor
"hogsend": minor
---

feat(voice): first-class voice channel — AI phone agents (Vapi), consent-gated, replay-safe

Adds a first-class **voice** channel (AI phone agents for marketing, data
collection, selling, and appointment booking), mirroring the email/SMS channel
architecture end-to-end.

- **`@hogsend/core`** — new provider-neutral `VoiceProvider` contract
  (`packages/core/src/providers/voice.ts`): `VoiceAgentConfig`, `VoiceToolSpec`,
  `StartCallOptions`, `VoiceEvent`/`VoiceEventType`, `VoiceToolCall`/
  `VoiceToolResult`, `VoiceWebhookParsed`, `VoiceProviderCapabilities`, and
  `defineVoiceProvider()`. Additive — re-exported from the `@hogsend/core` barrel.
- **`@hogsend/voice`** — new authoring package (voice sibling of `@hogsend/sms`):
  `defineVoiceAgent`, `defineVoiceTool`, the augmentable `VoiceAgentRegistryMap`,
  `renderVoiceAgent` + `{{variable}}` `interpolate`, and the registry helpers
  (`createVoiceRegistry`, `createVoiceToolRegistry`, `withSources`, …). Ships no
  concrete agents.

- **`@hogsend/plugin-vapi`** — the reference `VoiceProvider` (Vapi): `startCall`
  (transient-assistant `POST /call`), `verifyWebhook` (fail-closed `X-Vapi-Secret`),
  `parseWebhook`/`toVoiceWebhook` (status-update / end-of-call-report / tool-calls
  → `VoiceWebhookParsed`), `encodeToolResults`. Vapi composes Deepgram STT +
  ElevenLabs TTS under the hood, so it is the turnkey default.

- **`@hogsend/engine`** — the full voice pipeline: `VoiceProviderRegistry` +
  `voiceProvidersFromEnv` (Vapi env preset) + container wiring (`voice: { provider,
  providers, defaultProvider, agents, tools, from }`, active-provider resolution,
  inert stub when unconfigured, reserved `voice` connector id); `createTrackedVoiceCaller`
  (agent synthesis → consent/DNC gate → `voice_calls` write → `provider.startCall` →
  status/outcome persistence → mid-call tool dispatch); the journey-facing
  replay-safe `startCall()` (`voiceCall` key kind); `ctx.history.voice`; the voice
  leg of `checkJourneySuppress`; the opt-in `voice` channel list (`defaultOptIn:
  false`); and `POST /v1/webhooks/voice/:providerId` (synchronous tool-call replies
  + terminal-event journey-bus ingest).
- **`@hogsend/db`** — `voice_calls` + `voice_suppressions` tables + the
  `voice_call_status` enum + relations (migration `0047`).
- **`@hogsend/studio`** — a "Voice agents" view + `GET /v1/admin/voice-agents`
  (catalog) + `/:key/preview` (renders the synthesized agent config — prompt,
  voice, tools, data schema; no audio). First-party, mirroring the template
  preview (not a plugin — only providers are plugins).

Hardening in this pass: Vapi tool args read from `parameters` (not `arguments`);
mid-call tool dispatch gains scoped call-row resolution + per-agent authorization
+ `voice_tool_calls` idempotency + timeout + arg validation; no double-dial
(conflict-loser never re-places, `POST /call` no longer retries ambiguous
5xx/network); outcome ingest is awaited + idempotency-keyed (retry-safe, 500s so
Vapi retries); webhook secret is truly optional (accept when unset, `X-Vapi-Secret`
OR `Authorization: Bearer` when set); consent/compliance completed (opt-out tool
writes the DNC, TCPA calling-hours guard, recording OFF by default via
`artifactPlan.recordingEnabled`, E.164 normalization before DNC); inbound calls
implemented (`assistant-request` → inbound agent + row); `voice.*` added to the
outbound webhook catalog (+ vendored CLI/client copies) and emitted; extracted
structured data namespaced under `data` + written to contact properties. New
`voice_tool_calls` table (migration `0048`).

The remaining engine-line packages are bumped to keep the version line uniform
(release-doctor). Consumer wiring (`apps/api/src/voice/`), `docs/voice.md`, and the
Studio agent preview are included. Voice is an OPT-IN channel, so — exactly like
SMS/Twilio — it is intentionally NOT scaffold-pinned (the `create-hogsend` template
stays at the nine core packages; a scaffolded app opts in by adding `@hogsend/voice`
+ `@hogsend/plugin-vapi`). First npm publish of `@hogsend/voice` and
`@hogsend/plugin-vapi` must be manual.
