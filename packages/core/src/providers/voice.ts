// `WebhookHandshakeSignal` (channel-neutral) is defined in `./email.ts` and
// re-exported from the barrel — voice providers import it from `@hogsend/core`
// directly, the same way SMS providers do.

// ---------------------------------------------------------------------------
// JSON Schema (the data-collection + tool-parameter shape)
// ---------------------------------------------------------------------------

/**
 * A JSON Schema object literal (draft-07-ish). Used for two things the provider
 * needs verbatim: a tool's `parameters` (what the LLM may pass) and an agent's
 * `dataSchema` (the structured-data-extraction plan run after the call). Kept
 * intentionally loose — the engine never validates it, it is handed to the
 * provider as-is — but typed as an object so a bare string can't slip through.
 */
export type JsonSchemaObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Agent configuration (the provider-neutral "what to say / do" the engine hands
// the provider per call — the voice analogue of a rendered email/SMS body, but
// it is an AGENT CONFIG, not a rendered string: media/turn-taking/STT/LLM/TTS
// all run in the provider cloud)
// ---------------------------------------------------------------------------

/** The synthesized-voice selection. Provider-neutral; each provider maps it. */
export interface VoiceSpeechConfig {
  /** Voice-vendor id the provider composes (e.g. "elevenlabs", "playht"). */
  provider?: string;
  /** The vendor's voice id. */
  voiceId?: string;
}

/** The reasoning model behind the agent. Provider-neutral. */
export interface VoiceModelConfig {
  provider?: string;
  model?: string;
  temperature?: number;
}

/**
 * A tool the agent MAY call mid-conversation — the WIRE shape only (name +
 * JSON-schema params). The executable handler is NOT here: it lives in the
 * engine's tool registry (authored via `@hogsend/voice`'s `defineVoiceTool`) so
 * no implementation ever crosses the provider boundary. When the LLM decides to
 * call one, the provider POSTs a {@link VoiceToolCall} to the engine and blocks
 * on the {@link VoiceToolResult} reply.
 */
export interface VoiceToolSpec {
  name: string;
  description?: string;
  /** JSON Schema for the arguments the model must produce. */
  parameters: JsonSchemaObject;
}

/**
 * The provider-neutral agent the engine synthesizes per call and hands the
 * provider (as a "transient assistant" / inline config). Prompt fields may carry
 * `{{variable}}` placeholders resolved from {@link StartCallOptions.variables}.
 */
export interface VoiceAgentConfig {
  /** The system prompt / persona / instructions. */
  systemPrompt: string;
  /** The first line the agent speaks on an outbound call. */
  firstMessage?: string;
  voice?: VoiceSpeechConfig;
  model?: VoiceModelConfig;
  /** Tools the agent may call mid-call (wire specs only). */
  tools?: VoiceToolSpec[];
  /**
   * The structured-data-extraction plan: a JSON Schema the provider fills from
   * the transcript after the call. Surfaces as `VoiceEvent.ended.structuredData`
   * and the derived `voice.data_collected` event — the data-collection use-case.
   */
  dataSchema?: JsonSchemaObject;
  /** Phrases that end the call when the agent says them. */
  endCallPhrases?: string[];
  /** Hard cap on call length; the provider hangs up past it. */
  maxDurationSec?: number;
  /**
   * Whether the provider records the call. Providers default recording ON (Vapi:
   * `artifactPlan.recordingEnabled: true`), which is a two-party-consent hazard —
   * so this is `false` by default in the engine's agent authoring and only
   * enabled deliberately. When set, the provider maps it to its recording flag.
   */
  record?: boolean;
}

// ---------------------------------------------------------------------------
// Start-call options (the send wire — the voice analogue of SendSmsOptions)
// ---------------------------------------------------------------------------

/**
 * The single-recipient outbound-call wire. There is no cc/bcc — a call is one
 * E.164 callee. The engine synthesizes `agent` from the consumer's registered
 * `VoiceAgentDefinition` + props before this crosses the boundary.
 */
export interface StartCallOptions {
  /** E.164 callee. */
  to: string;
  /**
   * E.164 caller id. Optional — the provider may pin a default sender (a bought
   * number / phoneNumberId) at construction, in which case the engine leaves
   * this unset.
   */
  from?: string;
  /** The transient agent config for this call. */
  agent: VoiceAgentConfig;
  /** Values for `{{variable}}` placeholders in the agent's prompts. */
  variables?: Record<string, string | number | boolean>;
  /** Neutral passthrough — the engine threads the `voice_calls` row id here. */
  metadata?: Record<string, unknown>;
}

export interface VoiceStartResult {
  /** Provider call id. */
  id: string;
  /** Provider-reported initial status, if any (e.g. "queued", "ringing"). */
  status?: string;
}

// ---------------------------------------------------------------------------
// Provider-neutral voice events (the normalized webhook shape)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral call-failure classification. Mirrors {@link SmsFailureClass}:
 * `permanent` (dead/invalid number) can drive `voice_suppressions`, `transient`
 * (busy, no-answer, network) never suppresses, `unknown` is the conservative
 * default.
 */
export type VoiceFailureClass = "permanent" | "transient" | "unknown";

/**
 * Provider-neutral voice event types. The `voice.` prefix keeps the engine's
 * status-field map + outbound catalog uniform with the `email.`/`sms.` families.
 * `voice.call_ended` is the terminal event that carries the outcome (transcript,
 * recording, extracted structured data). `voice.no_answer`/`voicemail`/`failed`
 * are non-connect terminals.
 */
export type VoiceEventType =
  | "voice.call_started"
  | "voice.call_ended"
  | "voice.no_answer"
  | "voice.voicemail"
  | "voice.failed";

/** One turn of the transcript. `role` is the speaker. */
export interface VoiceTranscriptTurn {
  role: "agent" | "user" | "system" | "tool";
  text: string;
  /** Seconds from call start, best-effort. */
  at?: number;
}

/** The terminal-call payload on `voice.call_ended`. */
export interface VoiceCallOutcome {
  /** Provider `endedReason`, normalized to a stable bucket where possible. */
  reason: string;
  durationSec?: number;
  recordingUrl?: string;
  transcript?: VoiceTranscriptTurn[];
  summary?: string;
  /** The provider-extracted structured data (per the agent's `dataSchema`). */
  structuredData?: Record<string, unknown>;
  /** Best-effort provider-reported call cost, in the provider's currency. */
  cost?: number;
}

/**
 * The provider-neutral voice event every provider's `verifyWebhook`/
 * `parseWebhook` normalizes a lifecycle webhook into. The untouched provider
 * payload is preserved in `raw`. (A mid-call tool request is NOT an event — it
 * is normalized to {@link VoiceToolCall}; see {@link VoiceWebhookParsed}.)
 */
export interface VoiceEvent {
  type: VoiceEventType;
  /** Provider call id. */
  callId: string;
  /**
   * E.164 number. Outbound events: the CALLEE. For an inbound call: the CALLER
   * (the number that dialed us).
   */
  phone: string;
  /** ISO 8601 timestamp of the provider event. */
  occurredAt: string;
  /** Present on `voice.call_ended` — the call outcome. */
  ended?: VoiceCallOutcome;
  /** Present on `voice.failed`. `permanent` can drive suppression. */
  failure?: {
    class: VoiceFailureClass;
    code: string;
    reason?: string;
  };
  /** Present on an inbound call — the number that was dialed (our number). */
  inbound?: { to: string };
  /** The untouched provider payload, for handler escape-hatch + debugging. */
  raw: unknown;
}

/**
 * Per-event handler map — the voice sibling of {@link WebhookHandlerMap} /
 * {@link SmsWebhookHandlerMap}. Lets a consumer observe normalized voice events
 * after the engine's built-in handling runs.
 */
export type VoiceWebhookHandlerMap = {
  [K in VoiceEventType]?: (
    event: Extract<VoiceEvent, { type: K }>,
  ) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Mid-call tool calls (the synchronous request/response the SMS/email channels
// have no analogue for)
// ---------------------------------------------------------------------------

/**
 * A tool the agent invoked mid-call. The provider POSTs this to the engine's
 * voice webhook and BLOCKS the conversation waiting on the {@link VoiceToolResult}
 * reply, so the engine's handler must be fast. This is where booking, selling,
 * lookups, and incremental data-saves happen.
 */
export interface VoiceToolCall {
  callId: string;
  /** Provider-issued id correlating this call to its result. */
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

/** The engine's synchronous answer to a {@link VoiceToolCall}. */
export interface VoiceToolResult {
  toolCallId: string;
  /** The tool's return value, serialized to a string the LLM reads back. */
  result: string;
  /** The tool name — some providers (Vapi) echo it in the results envelope. */
  name?: string;
}

/**
 * An INBOUND-call assistant request. The provider forwards a call it received and
 * BLOCKS on the engine's synchronous reply selecting the agent to run. `caller`
 * is the E.164 that dialed us; `called` is the number they dialed (used to route
 * to an inbound agent).
 */
export interface VoiceAssistantRequest {
  callId: string;
  caller: string;
  called: string;
  raw: unknown;
}

/**
 * The three things a voice webhook can be, discriminated so the route knows
 * whether to dispatch a lifecycle event, run the tool dispatcher and reply, or
 * select an inbound assistant and reply — each of the latter two synchronous.
 */
export type VoiceWebhookParsed =
  | { kind: "event"; event: VoiceEvent }
  | { kind: "tool_call"; calls: VoiceToolCall[] }
  | { kind: "assistant_request"; request: VoiceAssistantRequest };

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` is the key the `VoiceProviderRegistry` indexes by and
 * the `:providerId` the `POST /v1/webhooks/voice/:providerId` route dispatches
 * on. REQUIRED (like {@link SmsProviderMeta} — no legacy voice providers).
 */
export interface VoiceProviderMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's wire can and can't do. All flags optional; absent is
 * treated conservatively.
 */
export interface VoiceProviderCapabilities {
  /** Can place outbound calls. */
  outboundCalls?: boolean;
  /** Forwards/routes inbound calls via webhook. */
  inboundCalls?: boolean;
  /** Has a crypto signature / shared-secret scheme on its webhooks. */
  signedWebhooks?: boolean;
  /** Issues synchronous mid-call tool calls the engine answers. */
  midCallTools?: boolean;
  /** Runs provider-side post-call structured-data extraction (`dataSchema`). */
  structuredExtraction?: boolean;
  /** Can record calls (capability-gated for two-party-consent compliance). */
  recording?: boolean;
  /** Supports context-preserving warm transfer to a human / another agent. */
  warmTransfer?: boolean;
}

// ---------------------------------------------------------------------------
// VoiceProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb call-placement + webhook parse/verify contract every voice provider
 * implements (Vapi, ElevenLabs Agents, Deepgram, …). All preference, consent,
 * DNC, calling-hours, DB, agent-synthesis, and tool-dispatch logic lives in the
 * engine's tracked voice sender + tool dispatcher, never here.
 */
export interface VoiceProvider {
  /** Provider identity. `meta.id` keys the registry + webhook route. REQUIRED. */
  readonly meta: VoiceProviderMeta;
  /** Optional declaration of what the provider's wire supports. */
  readonly capabilities?: VoiceProviderCapabilities;

  /** Place a single outbound call. Returns the provider call id. */
  startCall(options: StartCallOptions): Promise<VoiceStartResult>;

  /**
   * Verify the provider's webhook (owns its OWN secrets, constructed-in) and
   * return a normalized {@link VoiceWebhookParsed} — either a lifecycle event or
   * a mid-call tool request. Throws on a bad signature. Throws
   * {@link WebhookHandshakeSignal} for non-status handshakes / intermediate
   * events the route should 200 without dispatch. MAY be async.
   *
   * `url` is the canonical PUBLIC URL the provider POSTed to (the engine builds
   * it from `API_PUBLIC_URL` + path + query) — for providers that sign the URL,
   * `c.req.url` (wrong host behind a proxy) cannot be used.
   */
  verifyWebhook(opts: {
    payload: string;
    headers: Record<string, string>;
    url: string;
  }): Promise<VoiceWebhookParsed> | VoiceWebhookParsed;

  /** Parse an unsigned webhook payload (trusted contexts/tests). */
  parseWebhook(payload: string): VoiceWebhookParsed;

  /**
   * Serialize tool results into the provider's expected SYNCHRONOUS webhook
   * response body (the provider is blocking the call on this reply). Kept on the
   * provider because the wire shape is provider-specific (Vapi expects
   * `{ results: [...] }`).
   */
  encodeToolResults(results: VoiceToolResult[]): unknown;

  /**
   * Serialize an inbound-call assistant selection into the provider's expected
   * SYNCHRONOUS `assistant-request` response (Vapi expects `{ assistant: {...} }`).
   * `null` config ⇒ the provider's "reject/hang up" response. Present only when
   * `capabilities.inboundCalls`.
   */
  encodeAssistantResponse?(config: VoiceAgentConfig | null): unknown;
}

/**
 * Identity factory for a {@link VoiceProvider}. Mirrors `defineSmsProvider` /
 * `defineEmailProvider` — returns its argument unchanged but pins the literal
 * shape to the contract, so a typo in `meta` or a missing method is caught at
 * definition time.
 */
export function defineVoiceProvider(provider: VoiceProvider): VoiceProvider {
  return provider;
}
