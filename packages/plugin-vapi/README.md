# @hogsend/plugin-vapi

The reference [Vapi](https://vapi.ai) implementation of Hogsend's provider-neutral
`VoiceProvider` contract (`@hogsend/core`) — the voice sibling of
`@hogsend/plugin-twilio`. A **dumb wire**: it places outbound calls and
normalizes Vapi's webhooks; all consent, DNC, calling-hours, DB, agent-synthesis,
and mid-call tool-dispatch logic lives in the engine.

Vapi is the default because it is a turnkey orchestrator that owns telephony +
the STT/LLM/TTS loop and **composes Deepgram (STT) + ElevenLabs (TTS)** under the
hood — so choosing it does not forfeit their quality.

## What it does

- **`createVapiProvider({ apiKey, phoneNumberId, serverUrl?, webhookSecret? })`** —
  build the provider.
- **`startCall`** — `POST /call` with a **transient assistant** synthesized from
  the neutral `VoiceAgentConfig` (system prompt, voice, tools, `dataSchema` →
  `analysisPlan.structuredDataPlan`), `customer.number`, `phoneNumberId`,
  `assistantOverrides.variableValues`, and `metadata`. Retries transient 5xx/429;
  a 4xx is permanent (`VoiceCallError`).
- **`verifyWebhook`** — fail-closed shared-secret check of the `X-Vapi-Secret`
  header, then normalize.
- **`toVoiceWebhook` / `parseWebhook`** — map a Vapi server message
  (`{ message: { type, ... } }`) into a `VoiceWebhookParsed`:
  - `tool-calls` → `{ kind: "tool_call", calls }` (the engine answers
    synchronously),
  - `status-update` (`ringing`) → `voice.call_started`,
  - `end-of-call-report` → `voice.call_ended` / `voice.no_answer` /
    `voice.voicemail` / `voice.failed` with transcript + recording + summary +
    extracted structured data.
- **`encodeToolResults`** — serialize tool results into Vapi's `{ results: [{
  toolCallId, result }] }` reply.

## Setup

```bash
VAPI_API_KEY=...
VAPI_PHONE_NUMBER_ID=...        # a bought / imported Vapi number id
# VAPI_WEBHOOK_SECRET=...       # echoed as X-Vapi-Secret; verified fail-closed
```

Point the assistant/account **server URL** at
`${API_PUBLIC_URL}/v1/webhooks/voice/vapi` (the engine's env preset sets this on
each transient assistant automatically).

See `docs/voice-agent-plan.md` for the full channel architecture.
