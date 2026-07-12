import type {
  VoiceAgentConfig,
  VoiceAssistantRequest,
  VoiceEvent,
  VoiceEventType,
  VoiceProvider,
  VoiceToolCall,
  VoiceToolResult,
  VoiceWebhookHandlerMap,
} from "@hogsend/core";
import type {
  VoiceAgentName,
  VoiceAgentRegistry,
  VoiceAgentRegistryMap,
  VoiceToolRegistry,
} from "@hogsend/voice";
import type { FrequencyCapConfig } from "./email-service-types.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Tracked voice call (high-level API)
// ---------------------------------------------------------------------------

export interface StartTrackedCallOptions<
  K extends VoiceAgentName = VoiceAgentName,
> {
  agentKey: K;
  props: VoiceAgentRegistryMap[K];
  /** E.164 callee. */
  to: string;
  /** E.164 caller id (falls back to VOICE_FROM / the provider's pinned number). */
  from?: string;
  journeyStateId?: string;
  userId?: string;
  category?: string;
  /** Values for `{{variable}}` placeholders in the agent's prompts. */
  variables?: Record<string, string | number | boolean>;
  /**
   * Skips the consent + topic gates and the frequency cap — NEVER the phone DNC
   * list or the `unsubscribed_all` master opt-out, which are enforced
   * unconditionally (a transactional call must still honor a DNC).
   */
  skipPreferenceCheck?: boolean;
  idempotencyKey?: string;
}

export interface VoiceTrackedResult {
  voiceCallId: string;
  /** The provider's call id (empty until startCall returns / on a blocked call). */
  providerCallId: string;
  /**
   * `"started"` — the provider accepted the call. Non-connect verdicts:
   * `"suppressed"` (DNC list), `"unsubscribed"` (master opt-out / channel off),
   * `"no_consent"` (explicit voice consent missing), `"skipped"` (frequency cap /
   * journey suppress / quiet hours / test mode; see `reason`).
   */
  status: "started" | "suppressed" | "unsubscribed" | "no_consent" | "skipped";
  reason?:
    | "frequency_capped"
    | "journey_suppressed"
    | "quiet_hours"
    | "test_mode_blocked";
}

// ---------------------------------------------------------------------------
// Voice service (high-level DX) — engine-owned tracked voice caller
// ---------------------------------------------------------------------------

export interface VoiceServiceConfig {
  /** Default E.164 caller id (VOICE_FROM). */
  defaultFrom?: string;
  /** The client app's voice-agent registry (key → definition). */
  agents: VoiceAgentRegistry;
  /** The client app's voice-tool registry (name → executable tool). */
  tools?: VoiceToolRegistry;
  db?: unknown;
  webhookHandlers?: VoiceWebhookHandlerMap;
  /** Optional per-client frequency cap; undefined disables capping. */
  frequencyCap?: FrequencyCapConfig;
  logger?: Logger;
  /** Container-wired test-mode resolver. Absent ⇒ never active. */
  testMode?: () => boolean;
  /** Redirect target while test mode is active (env.HOGSEND_TEST_PHONE). */
  testPhone?: string;
  /** The active provider id, stamped on `voice_calls.provider_id`. */
  providerId?: string;
  /**
   * The agent to answer INBOUND calls with (the voice sibling of an inbound
   * auto-responder). Absent ⇒ inbound `assistant-request`s are declined. A single
   * inbound agent for now; per-number routing is a follow-up.
   */
  inboundAgent?: VoiceAgentName;
  /** Props for the inbound agent's `build`. */
  inboundProps?: Record<string, unknown>;
}

/**
 * A journey-bus ingest the route should push (via `ingestEvent`) so a journey
 * `ctx.waitForEvent` wakes on a call outcome. Returned by `handleWebhook`
 * because `ingestEvent` needs the container's `registry`/`analytics` the service
 * does not hold. Absent ⇒ nothing to ingest.
 */
export interface VoiceIngestDescriptor {
  userId: string;
  event: string;
  properties: Record<string, unknown>;
  /** Merged into `contacts.properties` (the collected-data → contact write). */
  contactProperties?: Record<string, unknown>;
  /** Deterministic key so a retried webhook doesn't double-emit into journeys. */
  idempotencyKey?: string;
}

export interface VoiceServiceWebhookResult {
  type: VoiceEventType;
  handled: boolean;
  ingest?: VoiceIngestDescriptor[];
}

export interface VoiceService {
  startCall<K extends VoiceAgentName>(
    options: StartTrackedCallOptions<K>,
  ): Promise<VoiceTrackedResult>;

  /**
   * Run a batch of mid-call tool calls through the tool registry and return the
   * results the provider blocks on. The webhook route calls this and replies
   * with `provider.encodeToolResults(...)`.
   */
  dispatchToolCalls(calls: VoiceToolCall[]): Promise<VoiceToolResult[]>;

  /**
   * Answer an INBOUND-call assistant request: select the configured inbound
   * agent, create the inbound `voice_calls` row, and return the synthesized
   * config (or null to decline). The webhook route wraps it via
   * `provider.encodeAssistantResponse`.
   */
  handleAssistantRequest(
    request: VoiceAssistantRequest,
  ): Promise<VoiceAgentConfig | null>;

  /**
   * Add a number to the internal voice DNC (`voice_suppressions`). Call it from a
   * mid-call opt-out tool (`getVoiceService().recordOptOut(ctx.phone)`) or an
   * inbound opt-out. Normalizes to E.164; a STOPped number is never dialed again
   * (transactional included) until the row is cleared.
   */
  recordOptOut(
    phone: string,
    opts?: { reason?: string; source?: string },
  ): Promise<void>;

  /**
   * Dispatch an already-verified, provider-neutral {@link VoiceEvent} into the
   * status/outcome pipeline. The webhook route owns provider resolution +
   * signature verification, and performs any returned journey-bus ingest.
   */
  handleWebhook(
    event: VoiceEvent,
    providerId?: string,
  ): Promise<VoiceServiceWebhookResult>;
}

/** The active voice provider a tracked caller delegates raw delivery to. */
export type { VoiceProvider };
