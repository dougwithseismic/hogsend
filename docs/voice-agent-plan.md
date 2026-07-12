# Voice agent channel — plan

**Status:** Phases 1–6 BUILT on `main` (Vapi provider, engine pipeline, DB,
routes, consumer wiring, docs, tests — all green). Remaining: calling-hours
guard, opt-out→DNC write, inbound DNC, external `voice.*` webhook catalog,
ElevenLabs/Deepgram providers (documented follow-ups in §7 + `docs/voice.md`).
**Goal:** add a first-class **voice** channel to Hogsend — AI voice agents that place
and answer phone calls to do marketing outreach, collect data, sell products, and
book appointments — mirroring the email/SMS channel architecture so a single
journey can reach a contact by email, SMS, **or** a phone call, on the same
contact and the same consent spine.

The homepage already commits the direction: _"Voice agents land on Vapi and
Deepgram — same journey, same contact."_ (`apps/docs/app/(landing)/page.tsx`).
This plan makes that concrete.

---

## 1. Which platform — Vapi vs ElevenLabs vs Deepgram

All three are viable, but they sit at **different layers of the stack**, so this
is not a straight "pick one" — it is "pick the default turnkey orchestrator, and
keep the contract provider-neutral so the others slot in."

| Dimension | **Vapi** | **ElevenLabs Agents** | **Deepgram Voice Agent API** |
|---|---|---|---|
| What it is | Turnkey **orchestrator** — owns the call loop, telephony wiring, assistant/squad model | Turnkey agent platform, **best-in-class voice** + native Twilio | Single-WebSocket STT+LLM+TTS **building block** |
| Telephony (out + in) | ✅ built-in (Twilio/Telnyx/Vonage import, buy numbers) | ✅ native Twilio (no TwiML), SIP, 200+ providers | ⚠️ native but still maturing — you wire the media stream |
| Tool / function calling mid-call | ✅ server-URL tools, synchronous result | ✅ server / client / system tools | ✅ built-in function calling |
| Post-call structured data | ✅ `analysisPlan` → structured JSON + summary + transcript + recording | ✅ post-call webhook: transcript + analysis + data-collection fields | ⚠️ you build it from the transcript stream |
| Multi-agent / warm transfer | ✅ Squads (context-preserving transfer) | ✅ agent transfer / handoff | ⚠️ DIY |
| Provider flexibility | ✅ BYO STT/LLM/TTS (uses **Deepgram STT + ElevenLabs TTS** under the hood) | EL stack (locked to their TTS, strongest there) | Deepgram stack + BYO LLM/TTS |
| Voice naturalness | Very good (composes ElevenLabs) | **Best** | Good (Aura-2), fast |
| Pricing | ~$0.05/min platform fee **+ passthrough** ≈ $0.23–0.33/min all-in | Bundled per-minute (EL tiers) | Flat/bundled ≈ $0.075/min standard, cheaper BYO; second-billed |
| Self-host | ❌ | ❌ | ✅ (option) |
| Best fit | **Engineering-led team wanting one control plane for marketing/sales/appointments** | Teams who want the most human-sounding voice | Cost-sensitive, latency-critical, DIY orchestration |

### Decision

**Default / reference provider: Vapi.** It is the only one of the three that is a
turnkey *control plane* for exactly our four use-cases (outbound + inbound
telephony, mid-call tool calls into Hogsend, and structured post-call data
extraction), and it is itself **provider-agnostic** — under the hood it composes
**Deepgram** for STT and **ElevenLabs** for TTS. So choosing Vapi as the default
does **not** forfeit the other two's strengths; it gets them, composed, behind one
API and one billing/telephony surface. This also matches the shipped homepage
copy.

Because the channel is built on a **provider-neutral `VoiceProvider` contract**
(exactly like `EmailProvider`/`SmsProvider`), the other two are additive later:

- **ElevenLabs Agents** — a `plugin-elevenlabs-voice` provider for teams that want
  the most natural voice and the native EL stack.
- **Deepgram Voice Agent** — a `plugin-deepgram` provider as the cost-optimized /
  self-hostable / latency-critical building block (aligns with the homepage's
  "Vapi and Deepgram").

Ship **Vapi first**; the other two are drop-in providers, not rewrites.

---

## 2. Why voice is NOT just "SMS with audio"

SMS/email are **fire-and-forget one-shot sends**. A voice call is a **stateful,
real-time, multi-turn conversation** whose media, turn-taking, STT/LLM/TTS all run
in the **provider's cloud** — Hogsend never touches audio. Hogsend's job is the
**control plane**:

1. **Author the agent** — system prompt, first line, voice, the tools it may call,
   and the JSON schema of data to extract. (This is the "template" analogue, but
   it is an *agent config*, not a rendered string.)
2. **Start the call** (outbound) or **route** an inbound call to an agent.
3. **Serve tool calls mid-call** — the agent phones back into Hogsend
   synchronously to *book an appointment*, *look up a product/price*, *save a
   collected field*, *create a checkout link*, *transfer to a human*. **This is
   where selling / appointments / data-collection actually happen.**
4. **Ingest the outcome** — on call end, persist transcript + recording + the
   extracted structured data, and emit outbound events (`voice.call_ended`,
   `voice.appointment_booked`, `voice.data_collected`, …) onto the same spine
   journeys already `waitForEvent` / branch on.

So the channel reuses the SMS *scaffolding* (registry, container wiring, tracked
pipeline, consent, webhook dispatch, DB-backed idempotency) but adds two things
SMS/email have no analogue for: a **mid-call tool-dispatch loop** and a
**call-lifecycle state machine**.

---

## 3. Architecture — mirror the SMS channel

SMS is the template (`docs/sms.md`). Voice mirrors it file-for-file where it can.

### 3.1 New packages

| Package | Mirrors | Role |
|---|---|---|
| `@hogsend/voice` | `@hogsend/sms` | Agent authoring: `defineVoiceAgent()`, augmentable `VoiceAgentRegistryMap`, prompt-variable interpolation, the data-collection schema type, `defineVoiceTool()`. **No React** — agents are prompt + config, not rendered HTML. |
| `@hogsend/plugin-vapi` | `@hogsend/plugin-twilio` | The reference `VoiceProvider`: `createVapiProvider` — `startCall`, `verifyWebhook`/`parseWebhook` (status-update, end-of-call-report, tool-calls, inbound), assistant-config translation. |
| *(later)* `@hogsend/plugin-elevenlabs-voice`, `@hogsend/plugin-deepgram` | — | Additive providers. |

### 3.2 Core contract — `packages/core/src/providers/voice.ts`

Mirrors `providers/sms.ts` / `providers/email.ts`. Sketch:

```ts
export interface VoiceProviderMeta { id: string; name: string; description?: string }

export interface VoiceProviderCapabilities {
  outboundCalls?: boolean;
  inboundCalls?: boolean;
  signedWebhooks?: boolean;
  midCallTools?: boolean;      // synchronous tool-call over the webhook
  structuredExtraction?: boolean; // provider-side post-call JSON extraction
  recording?: boolean;
  warmTransfer?: boolean;
}

// Provider-neutral agent config the engine hands the provider per call.
export interface VoiceAgentConfig {
  systemPrompt: string;
  firstMessage?: string;
  voice?: { provider?: string; voiceId?: string };
  model?: { provider?: string; model?: string; temperature?: number };
  tools?: VoiceToolSpec[];              // name + JSON-schema params, no impl
  dataSchema?: JsonSchema;              // structured-data extraction plan
  endCallPhrases?: string[];
  maxDurationSec?: number;
}

export interface StartCallOptions {
  to: string;                 // E.164 recipient
  from?: string;              // caller id (provider may pin default)
  agent: VoiceAgentConfig;    // transient agent (engine renders it per call)
  variables?: Record<string, string | number | boolean>; // prompt vars
  metadata?: Record<string, unknown>; // engine threads voiceCallId here
}
export interface VoiceStartResult { id: string; status?: string }

export type VoiceEventType =
  | "voice.call_started"     // ringing/answered
  | "voice.call_ended"       // terminal — carries outcome
  | "voice.no_answer"
  | "voice.voicemail"
  | "voice.failed";

export interface VoiceEvent {
  type: VoiceEventType;
  callId: string;            // provider call id
  phone: string;             // outbound: callee; inbound: caller
  occurredAt: string;
  ended?: {
    reason: string;                 // provider endedReason, normalized bucket
    durationSec?: number;
    recordingUrl?: string;
    transcript?: VoiceTranscriptTurn[];
    summary?: string;
    structuredData?: Record<string, unknown>; // the extracted data-collection
    cost?: number;
  };
  inbound?: { to: string };  // the number that was dialed
  raw: unknown;
}

// The synchronous mid-call tool call — the provider POSTs this and BLOCKS on the reply.
export interface VoiceToolCall {
  callId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}
export interface VoiceToolResult { toolCallId: string; result: string } // JSON string

export interface VoiceProvider {
  readonly meta: VoiceProviderMeta;
  readonly capabilities?: VoiceProviderCapabilities;
  startCall(opts: StartCallOptions): Promise<VoiceStartResult>;
  // Normalizes a provider webhook into either a lifecycle event OR a tool-call req.
  verifyWebhook(opts: { payload: string; headers: Record<string,string>; url: string }):
    Promise<VoiceWebhookParsed> | VoiceWebhookParsed;
  parseWebhook(payload: string): VoiceWebhookParsed;
  // Serialize a tool result back into the provider's expected sync response body.
  encodeToolResults(results: VoiceToolResult[]): unknown;
}
export type VoiceWebhookParsed =
  | { kind: "event"; event: VoiceEvent }
  | { kind: "tool_call"; calls: VoiceToolCall[] };

export function defineVoiceProvider(p: VoiceProvider): VoiceProvider { return p }
```

Re-export from `@hogsend/core` barrel and `@hogsend/engine`, same as the SMS/email
contracts.

### 3.3 Engine wiring — `packages/engine/src`

Mirror the SMS pieces (paths confirmed against the SMS build):

- **`container.ts`** — build `VoiceProviderRegistry` (keyed by `meta.id`), resolve
  the active provider (`voice.defaultProvider ?? VOICE_PROVIDER ?? "vapi"`, or the
  sole registered one; unresolvable explicit id throws), add `voiceProviders` +
  `voiceProvider` + `voiceAgents` + `voiceService` to `HogsendClient`. `env`
  presets: `voiceProvidersFromEnv` (Vapi when `VAPI_API_KEY` set), behind a guarded
  dynamic import like `smsProvidersFromEnv`. **Opt-in**: no provider ⇒ inert stub,
  `startCall` throws (unchanged deploys unaffected).
- **`lib/voice.ts`** — `startCall()` journey helper. Replay-safe via a new
  **`voiceCall` key kind** (`journeyVoiceCall:<runAnchor>:<site>:<agent>`), disjoint
  from `send`/`smsSend` — a call is an exactly-once side effect on replay. Threads
  the deterministic key into `voice_calls.idempotencyKey` (Layer 2) + Hatchet memo
  (Layer 1), exactly like `sendSms`.
- **Supporting engine libs** (mirror the SMS file set 1:1):
  `lib/voice-provider-registry.ts` (`VoiceProviderRegistry`, keyed by `meta.id`),
  `lib/voice-providers-from-env.ts` (`voiceProvidersFromEnv` — guarded dynamic
  import of `@hogsend/plugin-vapi`, an engine `optionalDependency`),
  `lib/voice-service-types.ts` (`VoiceService`, `StartTrackedCallOptions`,
  `VoiceTrackedResult` with `status`/`reason` unions), `lib/voice-frequency-cap.ts`
  (`isVoiceFrequencyCapped` over `voice_calls`, separate budget).
- **`lib/voice-mailer.ts` (the tracked sender, sibling of `sms-mailer.ts`) +
  `lib/voice-tracked.ts`** — the tracked call pipeline, stage-for-stage with
  `createTrackedSmsSender`/`sendTrackedSms`:
  1. Idempotency short-circuit (a dispatched call row is a satisfied duplicate).
  2. Suppression + consent — voice DNC list (`voice_suppressions`) +
     `unsubscribed_all` + explicit **voice** consent gate + topic gate. **Voice
     consent is the strictest** (see §5).
  3. **Calling-hours guard** — TCPA 8am–9pm *recipient-local* window; outside ⇒
     `quiet_hours` (a journey can `ctx.when` to schedule instead).
  4. Frequency cap over `voice_calls` (separate budget from email/SMS).
  5. Journey `meta.suppress` min-gap over voice history.
  6. Test-mode redirect to `HOGSEND_TEST_PHONE` (reuse the SMS/email test-mode
     coherence — a staging deploy never live-dials real numbers).
  7. Render the agent (interpolate `variables` into the system prompt / first
     message) → insert `voice_calls` `queued` row → `provider.startCall` → update
     `initiated` + provider callId → emit `voice.call_started`.
- **`lib/voice-tools.ts`** — the **mid-call tool dispatcher**. Given a
  `VoiceToolCall`, resolve the registered `defineVoiceTool` by name, run its
  handler `(args, { call, contact, container }) => result`, and return a
  `VoiceToolResult`. Built-in tools shipped by the engine: `bookAppointment`,
  `saveContactData`, `checkAvailability`, `transferToHuman`, `endCall`,
  `triggerJourney`. Consumer tools are additive. **This is the selling /
  appointments / data-collection engine.**
- **`lib/voice-webhook.ts` / `lib/voice-inbound.ts`** — terminal-event handling:
  persist transcript/recording/structuredData onto the `voice_calls` row (guarded
  monotonic, like SMS status), write extracted fields to contact properties +
  PostHog, emit `voice.call_ended` (+ derived `voice.appointment_booked` /
  `voice.data_collected` when the outcome says so) onto the outbound spine and
  through `ingestEvent`. Inbound calls route to a consumer-registered inbound
  agent by dialed number.

### 3.4 Journey context + replay key

- **Type** in `packages/core/src/types/journey-context.ts`: add
  `VoiceHistoryOptions`/`VoiceHistoryResult` + `history.voice(opts)` alongside
  `history.sms`.
- **Impl** in `packages/engine/src/journeys/journey-context.ts`:
  `ctx.history.voice({ phone, agent })` → `{ called, lastCalledAt, count }` —
  `COUNT` + `MAX(startedAt)` over `voice_calls` by `toPhone` + `agentKey`,
  mirroring the `history.sms` impl.
- **Replay key** in `packages/engine/src/journeys/journey-boundary.ts`: extend
  `JourneyKeyKind` with `"voiceCall"` and `KEY_PREFIX` with
  `voiceCall → "journeyVoiceCall"` (disjoint from `send`/`smsSend`/`trigger`/
  `connector`). `deriveJourneyKey` + `registerKey` are reused unchanged.
- Journeys consume outcomes via the existing `ctx.waitForEvent({ event:
  "voice.call_ended" })` → `properties` (outcome/structuredData as scalars) and
  branch. Never put the awaited event in `exitOn` (same rule as semantic clicks).

### 3.5 Routes — `packages/engine/src/routes/webhooks/`

- **`voice-provider.ts`** — `POST /v1/webhooks/voice/:providerId`. Resolve provider
  → `verifyWebhook`. If `kind === "event"` → hand to `voiceService.handleWebhook`.
  If `kind === "tool_call"` → run the tool dispatcher and **respond synchronously**
  with `provider.encodeToolResults(...)` (the provider blocks the call waiting on
  this HTTP reply). Registered **before** the `:sourceId` catch-all; **`"voice"`
  is a reserved connector/source id** (like `"sms"`/`"email"`).

### 3.6 DB — `packages/db/src`

New tables + one migration (next number after `0046`, e.g. `0047_*.sql`). Add a
`voice_call_status` `pgEnum` in `schema/enums.ts`; new `schema/voice-calls.ts` +
`schema/voice-suppressions.ts`; barrel + `schema/relations.ts` additions (mirror
`sms-sends`/`sms-suppressions`):

- **`voice_calls`** — `id`, `contactId`/`userId`, `agentKey`, `providerId`,
  `providerCallId`, `direction` (`outbound`|`inbound`), `status`
  (`queued`|`ringing`|`in_progress`|`completed`|`failed`|`no_answer`|`voicemail`),
  `fromNumber`, `toNumber`, `startedAt`, `endedAt`, `durationSec`, `endedReason`,
  `recordingUrl`, `transcript` (jsonb), `summary`, `structuredData` (jsonb),
  `cost`, `idempotencyKey` (unique), `metadata` (jsonb), `createdAt`.
- **`voice_suppressions`** — `phone`, `reason` (`dnc`|`opt_out`|`carrier`),
  `source`, `createdAt`. Separate from `sms_suppressions` — a contact may accept
  SMS but not calls, and vice-versa.
- Reuse existing **`contacts.phone`** (added by the SMS channel) + the
  `tracked_links`/`link_clicks` spine is **not** needed for voice.

### 3.7 Consumer wiring — `apps/api` + `packages/create-hogsend/template`

- Pass `voice: { agents, tools }` to `createHogsendClient` in **both** `index.ts`
  and `worker.ts` (same rule as `sms: { templates }`).
- `src/voice/` — agent definitions (`sales-agent.ts`, `appointment-setter.ts`,
  `data-collector.ts`), `registry.ts`, custom `tools.ts`, `templates.d.ts`
  augmenting `VoiceAgentRegistryMap`, and `constants/` (`Agents`, `VoiceEvents`).
- Ship 1–2 example journeys (e.g. `voice-appointment-reminder`,
  `voice-lead-qualifier`).
- Note: the `packages/create-hogsend/template/` scaffold does **not** yet ship an
  `src/sms/` dir — so it has no channel-dir precedent to copy. Mirror
  `apps/api/src/voice/` into the template as part of this phase (and consider
  back-filling `src/sms/` for parity).

---

## 4. The four use-cases → how each is served

| Use-case | How it works |
|---|---|
| **Marketing / outreach** | A journey calls `startCall({ agent: "promo-agent", to, variables })`; the agent pitches, gauges interest, and emits `voice.call_ended` with `structuredData.interested`; the journey branches (book a follow-up, send an SMS, enroll in nurture). |
| **Collecting data** | The agent's `dataSchema` (JSON schema) drives provider-side structured extraction → `voice.data_collected` with the fields → written to contact properties + PostHog. Incremental fields can also be saved mid-call via the `saveContactData` tool. |
| **Selling products** | Mid-call tools: `getProduct`/`checkInventory` (read your catalog), `createCheckout`/`sendPaymentLink` (Stripe → follow-up SMS/email), `transferToHuman` (warm transfer to a closer). Outcome events feed revenue attribution in PostHog. |
| **Appointments** | The `bookAppointment` tool hits your calendar (Cal.com / Google Calendar) with `checkAvailability` first → `voice.appointment_booked` event → confirmation SMS/email journey + a `voice-appointment-reminder` journey the day before. |

Every outcome is an event on the **same ingestion spine**, so voice composes with
email + SMS in one journey: _call → if no-answer, SMS → if still cold, email._

---

## 5. Consent & compliance — the hard part, do it right

Voice marketing is the **most-regulated** channel. The gate must be stricter than
SMS:

- **TCPA** — telemarketing calls (and any call using an artificial/prerecorded or
  AI voice) require **prior express *written* consent**. An AI voice agent is
  squarely in scope. Gate on an explicit `categories.voice === true` grant; fail
  **closed** (`no_consent`) otherwise, exactly like the SMS consent gate.
- **DNC** — honor the phone-keyed `voice_suppressions` list (internal DNC);
  operators wire the national/state DNC scrub upstream. A suppressed number is
  never dialed and never bypassed (transactional calls bypass only the *marketing*
  consent gate, never the DNC/`unsubscribed_all` list).
- **Calling hours** — enforce the 8am–9pm **recipient-local** window in the
  pipeline (§3.3 step 3); resolve tz the same way `ctx.when` does (PostHog →
  contact → client default → UTC).
- **AI-disclosure** — the agent's opening line must disclose it is an AI/automated
  system where required (state laws, e.g. CA/others). Ship this in the example
  agents' `firstMessage` and document it.
- **Recording consent** — two-party-consent states require a recorded-line
  disclosure; the agent discloses at open, and `recording` is capability-gated.
- **Opt-out** — the agent honors "stop calling me" via an `optOut` tool →
  `voice_suppressions(opt_out)` + `contact.unsubscribed` (voice channel). Inbound
  DNC requests handled the same way.

Consent grants/revocations emit `contact.subscribed`/`contact.unsubscribed` with
`source` provenance — the same audit signal SMS uses. The preference center gets a
**voice** row (OFF by default until granted).

> This plan surfaces the compliance model but the operator remains responsible for
> DNC scrubbing, per-state registration, and written-consent capture. Document
> loudly in `docs/voice.md`.

---

## 6. Phased build plan

Each phase is independently shippable and green (`pnpm check-types` + `pnpm lint`
+ tests). Scaffolding a brand-new `@hogsend/*` package means its **first npm
publish is manual** (per the release skill).

- **Phase 1 — contract + agent package.** `packages/core/src/providers/voice.ts`
  (`VoiceProvider`, `VoiceEvent`, `VoiceToolCall`, `defineVoiceProvider`) +
  `@hogsend/voice` (`defineVoiceAgent`, `defineVoiceTool`, registry, variable
  interpolation, `VoiceAgentRegistryMap`). Re-export from `@hogsend/engine`. Env
  vars added to `env.ts` (all optional).
- **Phase 2 — Vapi provider.** `@hogsend/plugin-vapi`: `startCall` (POST `/call`
  with transient `assistant` + `phoneNumberId` + `customer.number` +
  `assistantOverrides.variableValues` + `metadata`), `verifyWebhook` (shared-secret
  header) normalizing `status-update` / `end-of-call-report` / `tool-calls` /
  inbound into `VoiceWebhookParsed`, `encodeToolResults` (`{ results: [...] }`).
- **Phase 3 — engine pipeline + DB + routes.** `voice_calls` + `voice_suppressions`
  tables + migration; `container.ts` registry + resolution + env preset;
  `lib/voice-caller.ts`/`voice-tracked.ts`/`voice.ts`/`voice-tools.ts`/
  `voice-webhook.ts`; `routes/webhooks/voice-provider.ts` + reserved-id guard.
  Built-in tools (`bookAppointment`, `saveContactData`, `checkAvailability`,
  `transferToHuman`, `endCall`, `triggerJourney`).
- **Phase 4 — journey integration.** `ctx.history.voice`, `voiceCall` replay key
  kind, the `voice.*` outbound-event catalog, `waitForEvent` outcome plumbing.
- **Phase 5 — consent/compliance.** Voice consent gate, DNC list, calling-hours
  guard, opt-out tool + inbound DNC, preference-center voice row, AI/recording
  disclosure in examples.
- **Phase 6 — consumer + docs + tests.** `apps/api` + template `src/voice/` with
  example agents/tools/journeys; `docs/voice.md` (mirror `docs/sms.md`);
  vitest coverage (pipeline gates, webhook verify/parse, tool dispatch,
  idempotency, consent). Update `CLAUDE.md` architecture section + landing copy
  (`REACH_NOW`/`REACH_SOON`).
- **Phase 7 — later providers + Studio.** `plugin-elevenlabs-voice`,
  `plugin-deepgram`; Studio agent preview + a blueprint `place_call` node.

---

## 7. Deferrals (v1)

- ElevenLabs + Deepgram providers (Vapi ships first; contract makes them additive).
- Studio voice-agent preview + blueprint `place_call` node (journeys reach voice
  via code first, like SMS).
- National/state DNC auto-scrub integration (operator wires upstream in v1).
- Phone as a merge-participating identity `Kind` (STOP/DNC resolves a contact by a
  direct `contacts.phone` lookup, same limitation as SMS v1).
- Live call-audio streaming into Hogsend, real-time barge-in control, voicemail
  drop, and multi-language auto-switch (provider-owned; expose later).

---

## 8. Risks / open questions

- **Cost visibility** — voice is $0.20–0.35/min all-in; add per-call cost to
  `voice_calls` + a spend guard / daily cap in the pipeline.
- **Latency of tool calls** — mid-call tools block the conversation; built-in
  tools must be fast (<1s) or the agent stalls. Document a timeout + graceful
  "let me check and text you" fallback.
- **Webhook auth** — confirm Vapi's exact secret/signature scheme during Phase 2
  (docs list a server secret header; verify before trusting payloads).
- **Idempotency of `startCall`** — a real second call is a legitimate
  re-enrollment, but a replay must not double-dial; the `voiceCall` key + row
  short-circuit handle it, but test crash-mid-`startCall` explicitly.
- **Inbound routing** — mapping a dialed number → inbound agent needs a
  number-registry (defer a full UI; env/config map in v1).
</content>
</invoke>
