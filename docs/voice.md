# Voice channel

Hogsend's voice channel adds AI phone agents — outbound and inbound calls that do
marketing outreach, collect data, sell, and book appointments — mirroring the
email/SMS architecture: a provider-neutral `VoiceProvider` contract, a dumb
provider plugin ([Vapi](https://vapi.ai) is the reference), an engine-owned
tracked caller, agent definitions authored in code, a replay-safe `startCall()`
for journeys, mid-call tool dispatch, delivery/outcome webhooks, and a strict
TCPA consent model. Configuring the channel is **operator opt-in**: with no
provider configured the voice service is an inert stub and `startCall` throws — an
existing deploy without Vapi credentials is unaffected. Calling a contact is
**recipient opt-in**: marketing calls require an explicit voice consent grant (see
[Consent](#consent-tcpa)).

Voice is **not** "SMS with audio": media, turn-taking, and the STT/LLM/TTS loop
all run in the provider's cloud. Hogsend is the control plane — it authors the
agent, starts the call, **serves mid-call tool calls** (this is where booking /
selling / data collection happen), and ingests the outcome onto the same journey
spine.

## Why Vapi (and Deepgram / ElevenLabs)

Vapi is the default because it is a turnkey orchestrator that owns telephony + the
conversation loop and is itself provider-agnostic — it **composes Deepgram (STT) +
ElevenLabs (TTS)** under the hood. So choosing Vapi doesn't forfeit their quality;
it gets them, composed, behind one API + one billing/telephony surface. The
contract is provider-neutral, so an ElevenLabs-Agents or Deepgram-Voice-Agent
provider slots in later without touching the engine.

## Setup

```bash
VAPI_API_KEY=...
VAPI_PHONE_NUMBER_ID=...          # a bought / imported Vapi number id (outbound)
# VAPI_WEBHOOK_SECRET=...         # echoed as X-Vapi-Secret; verified fail-closed
# VOICE_PROVIDER=vapi             # active provider id (default "vapi")
# VOICE_FROM=+15551234567         # default caller id (provider may pin its own)
# HOGSEND_TEST_PHONE=+15557654321 # redirect target while voice test mode is armed
```

Point Vapi's assistant/account **server URL** at
`<API_PUBLIC_URL>/v1/webhooks/voice/vapi` — the engine's env preset sets this on
each transient assistant automatically (so status, end-of-call, and tool-call
events route back).

## Authoring an agent

Voice agents are `@hogsend/voice` `defineVoiceAgent` definitions (prompt + voice +
tools + data schema), authored in the consumer's `src/voice/` — **not** React:

```ts
// src/voice/appointment-setter.ts
import { defineVoiceAgent } from "@hogsend/voice";

export const appointmentSetter = defineVoiceAgent({
  category: "journey",
  build: (p: { businessName: string; firstName?: string }) => ({
    // Build prompts from PROPS (`${p.x}`) — a `{{variable}}` placeholder would
    // need a matching `variables` bag on `startCall`, or Vapi leaves it literal.
    systemPrompt: `You are the scheduling assistant for ${p.businessName}. \
Disclose you are an automated AI assistant. Book a demo via bookAppointment.`,
    firstMessage: `Hi ${p.firstName ?? "there"}, this is the automated assistant for ${p.businessName}.`,
    voice: { provider: "11labs", voiceId: "burt" }, // Vapi needs a voiceId
    tools: [{ name: "bookAppointment", parameters: { type: "object", properties: { slotIso: { type: "string" } }, required: ["slotIso"] } }],
    dataSchema: { type: "object", properties: { interested: { type: "boolean" } } },
    // record defaults OFF (two-party-consent safe); set `record: true` to enable.
  }),
});
```

Register agents + tools in `src/voice/registry.ts`, augment `VoiceAgentRegistryMap`
in `src/voice/templates.d.ts`, and pass `voice: { agents, tools }` to
`createHogsendClient` in **both** `index.ts` and `worker.ts`.

## Calling from a journey

```ts
import { defineJourney, startCall, isE164 } from "@hogsend/engine";

export const voiceLeadQualifier = defineJourney({
  meta: { id: "voice-lead-qualifier", name: "Voice — Lead qualifier", trigger: { event: "lead.created" } },
  run: async (user, ctx) => {
    const phone = user.properties.phone ? String(user.properties.phone) : null;
    if (!phone || !isE164(phone)) return;

    await startCall({ to: phone, userId: user.id, agent: "appointment-setter", props: { businessName: "Acme" } });

    // Wait for the outcome the webhook ingests, then branch.
    const { timedOut, properties } = await ctx.waitForEvent({ event: "voice.call_ended", timeout: { minutes: 10 } });
    if (!timedOut && properties?.reason?.toString().includes("no-answer")) {
      // ...fall back to SMS/email...
    }
  },
});
```

`startCall` is replay-safe exactly like `sendEmail` / `sendSms`: it derives a
deterministic key from the journey boundary using the `voiceCall` kind
(`journeyVoiceCall:<runAnchor>:<site>:<agent>`), a namespace **disjoint** from
email's `journeySend:` and SMS's `journeySmsSend:` — so a message and a call under
one wait label never collide, and a durable replay never double-dials (absorbed by
the unique `voice_calls.idempotencyKey` index + Hatchet's memo).

## The tracked pipeline

`createTrackedVoiceCaller` owns the pipeline stage-for-stage with the SMS caller:

1. **Idempotency short-circuit** — a dispatched `voice_calls` row is a satisfied
   duplicate; an orphaned `queued` row (crash before the provider id was recorded)
   is re-driven.
2. **Consent + DNC** (always; transactional / `skipPreferenceCheck` bypass only
   the consent + topic gates): an internal `voice_suppressions` (DNC) row →
   `suppressed` (never bypassed); the contact's `unsubscribed_all` → `unsubscribed`
   (never bypassed); the explicit voice-consent gate → `no_consent` /
   `channel_off`; the topic gate → `unsubscribed`. A blocked call writes a `failed`
   row **without** consuming the idempotency key.
3. **Frequency cap** — a separate `isVoiceFrequencyCapped` over `voice_calls`
   (email/SMS/voice budgets never consume each other).
4. **Journey suppress** — the `meta.suppress` per-recipient min-gap over voice
   history (the voice leg of `checkJourneySuppress`).
5. **Test mode** — deploy-wide coherence with email/SMS: `HOGSEND_TEST_MODE=true`
   forces voice test mode, `auto` arms it whenever the email side is armed — a
   staging deploy never live-dials real numbers. Redirects to `HOGSEND_TEST_PHONE`
   (blocked + recorded when unset).
6. Render the agent (interpolate `{{variables}}`) → insert `queued` `voice_calls`
   row → `provider.startCall` → record the provider call id + `ringing`.

## Webhooks — status, outcome, and mid-call tools

`POST /v1/webhooks/voice/:providerId` resolves the provider, verifies the
signature (Vapi's `X-Vapi-Secret`, fail-closed), and handles the normalized
`VoiceWebhookParsed`:

- **`tool_call`** — the engine's dispatcher resolves each tool by name against the
  registered tool registry, runs its handler with the resolved call context
  (contact/agent/phone), and **replies synchronously** with the provider-encoded
  results (the provider blocks the conversation on this reply). Booking, selling,
  lookups, and incremental data-saves all run here. A fast handler is essential.
- **`event`** — advances the `voice_calls` status (guarded monotonic — provider
  callbacks are unordered) and persists the outcome (transcript, recording,
  summary, extracted structured data, duration, cost). Terminal events are then
  pushed onto the **journey bus** via `ingestEvent` (`voice.call_ended`,
  `voice.no_answer`, `voice.voicemail`, `voice.failed`, plus a derived
  `voice.data_collected` when structured data is present) so a `ctx.waitForEvent`
  wakes. A permanent-class failure auto-adds the number to the internal DNC.

## The four use-cases

| Use-case | How it works |
|---|---|
| **Marketing** | A journey `startCall`s; the agent pitches; `voice.call_ended` carries the outcome the journey branches on. |
| **Data collection** | The agent's `dataSchema` drives provider-side structured extraction → `voice.data_collected` with the fields → contact properties + PostHog. |
| **Selling** | Mid-call tools: `getProduct` / `createCheckout` (payment link) / `transferToHuman`. |
| **Appointments** | The `bookAppointment` tool hits your calendar → the journey sends a confirmation SMS/email + schedules a reminder. |

## Consent (TCPA)

Voice is the **strictest-regulated** channel and the `voice` list registers
`defaultOptIn: false` (not configurable). TCPA requires prior express **written**
consent for AI/prerecorded marketing calls, so holding a phone number is not
permission to call it. A marketing call needs an explicit `categories.voice ===
true` grant on the contact's `email_preferences` (lists API / SDK / preference
center). Without it the call fails **closed** (`no_consent`). Transactional calls
(`category: "transactional"` / `skipPreferenceCheck`) are exempt from the consent
gate but **never** from the internal DNC list or `unsubscribed_all`.

The engine enforces the compliance controls it can: **DNC** (the internal
`voice_suppressions` list — a mid-call `optOut` tool or an admin write adds a
number, and it is never dialed again, transactional included); **calling hours**
(TCPA 8am–9pm — enforced against the contact's `timezone` property when known,
skipped when the tz can't be resolved rather than risk a wrong-tz block);
**recording OFF by default** (`artifactPlan.recordingEnabled: false` unless the
agent sets `record: true` — a two-party-consent safeguard); and **E.164
normalization** before every DNC check. Still the operator's responsibility:
national/state DNC scrubbing (wire upstream), written-consent capture, per-state
registration, and the AI-disclosure opening line (ship it in your `firstMessage`,
as the example does) + a recorded-line disclosure where you enable recording.

## Adding another provider

Scaffold `packages/plugin-<name>` mirroring `plugin-vapi`: implement `createXProvider`
via `defineVoiceProvider()` (map the neutral `VoiceAgentConfig` to the vendor's
assistant shape, normalize webhooks to `VoiceWebhookParsed`, verify the provider's
signature, `encodeToolResults` in the vendor's reply shape), and add an optional
env preset to `voiceProvidersFromEnv` behind a guarded dynamic import. A brand-new
`@hogsend/*` package's first npm publish must be manual.

## Model selection

Vapi is provider-agnostic (OpenAI / Anthropic / Google / Groq / custom), so pick
the agent's brain per agent via `model: { provider, model }`. The default is the
latest fast Claude — **`claude-sonnet-4-6`** — because for VOICE the model must be
low-latency and **non-reasoning**: a reasoning/thinking model's time-to-first-token
explodes into audible pauses that get callers to hang up. Keep reasoning OFF for
the user-facing turn (use it only for offline post-call analysis). For the lowest
latency on short conversational turns, drop to `claude-haiku-4-5-20251001`. Cap responses
short (voice replies are concise) for faster turns.

## Deferrals (v1)

- **Per-number inbound routing** — a single configured `inboundAgent` answers all
  inbound calls today; routing by the dialed number is a follow-up.
- **ElevenLabs + Deepgram providers**, a blueprint `place_call` node, live audio
  streaming, voicemail drop, and phone as a merge-participating identity `Kind`.

## Studio preview

`GET /v1/admin/voice-agents` + `/v1/admin/voice-agents/:key/preview` render an
agent's **synthesized config** — the interpolated system prompt + first message,
the voice/model selection, the tool wire-specs, and the data-collection schema
the engine would hand the provider on a real call (there is no audio to render;
media is provider-side). The Studio "Voice agents" view lists the registered
agents and shows this preview, mirroring the email template preview. It is a
first-party engine + Studio surface (not a plugin — only providers are plugins).
```
