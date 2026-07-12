import type { VoiceAgentConfig, VoiceToolSpec } from "@hogsend/core";

// ---------------------------------------------------------------------------
// Voice agent registry (open, augmentable — module augmentation)
// ---------------------------------------------------------------------------

/**
 * The set of voice-agent keys known to the type system, and the props each key
 * expects. Ships EMPTY — `@hogsend/voice` bakes in no concrete agents. Client
 * apps declare theirs by augmenting it:
 *
 * ```ts
 * declare module "@hogsend/voice" {
 *   interface VoiceAgentRegistryMap {
 *     "appointment-setter": { businessName: string; slots: string[] };
 *   }
 * }
 * ```
 *
 * After augmentation, `VoiceAgentName` resolves to the client's keys and
 * `startCall({ agent, props })` is fully type-checked. A SEPARATE namespace from
 * the email/SMS template maps — a voice agent must not be sendable as an email.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally open for client augmentation
export interface VoiceAgentRegistryMap {}

export type VoiceAgentName = keyof VoiceAgentRegistryMap;

/**
 * A voice-agent definition — the authoring analogue of an email/SMS template,
 * but it produces an AGENT CONFIG (prompt + tools + data schema), not a rendered
 * string. `build` maps typed props to the provider-neutral {@link VoiceAgentConfig}
 * (prompt fields may carry `{{variable}}` placeholders resolved at call time).
 */
export interface VoiceAgentDefinition<P = Record<string, unknown>> {
  /** Map props → the agent config the engine hands the provider per call. */
  build: (props: P) => VoiceAgentConfig;
  /**
   * Optional list category (a topic id, `"transactional"`, or `"journey"`).
   * Drives the voice preference/consent gate, exactly like the SMS category.
   */
  category?: string;
  /** Human-facing description for admin catalogs / Studio. */
  description?: string;
  /** Sample props for admin previews. Illustrative — never used at call time. */
  examples?: Partial<P>;
  /** Best-effort absolute source path for a Studio "open in editor" affordance. */
  sourcePath?: string;
}

export type VoiceAgentRegistry = {
  [K in VoiceAgentName]: VoiceAgentDefinition<VoiceAgentRegistryMap[K]>;
};

/** The resolved-and-interpolated agent, ready to hand a provider. */
export interface VoiceAgentRenderResult {
  config: VoiceAgentConfig;
  category?: string;
}

// ---------------------------------------------------------------------------
// Voice tools (the executable side of the wire-only VoiceToolSpec)
// ---------------------------------------------------------------------------

/**
 * The context the engine passes a tool handler when the agent invokes the tool
 * mid-call. Deliberately minimal + engine-neutral (no DB/container types) so the
 * authoring package stays free of an engine dependency; the engine may pass a
 * structurally-wider object.
 */
export interface VoiceToolContext {
  /** Provider call id the tool was invoked during. */
  callId: string;
  /** E.164 (normalized) of the other party (callee outbound, caller inbound). */
  phone: string;
  /** The agent key driving the call, when known. */
  agentKey?: string;
  /**
   * The contact's external/user id (the `voice_calls.user_id` — the denormalized
   * identity every channel keys on), when the call maps to a contact. This is
   * the key you pass to contact/preference APIs, NOT the `contacts.id` row uuid.
   */
  userId?: string;
  /** The call's dynamic variables (as supplied to `startCall`). */
  variables?: Record<string, string | number | boolean>;
}

/**
 * What a tool handler returns. A string is sent to the LLM verbatim; anything
 * else is JSON-serialized by the engine before it becomes a {@link VoiceToolResult}.
 */
export type VoiceToolHandlerResult =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>;

/**
 * An executable voice tool: the wire `spec` (name + JSON-schema params, sent to
 * the provider) plus the `handler` the engine runs when the agent calls it. This
 * is where booking / selling / lookups / incremental data-saves live.
 */
export interface VoiceTool<A = Record<string, unknown>> {
  spec: VoiceToolSpec;
  // Method syntax (not an arrow property) is deliberate: it makes the `args`
  // parameter bivariant, so a tool authored with a specific arg type
  // (`VoiceTool<{ slotIso: string }>`) is assignable into the erased
  // `VoiceToolRegistry` (`VoiceTool<Record<string, unknown>>`). The engine calls
  // the handler with JSON-parsed args matching the declared `spec.parameters`.
  handler(
    args: A,
    ctx: VoiceToolContext,
  ): VoiceToolHandlerResult | Promise<VoiceToolHandlerResult>;
}

/** Name-keyed tool map the engine's mid-call dispatcher resolves against. */
export type VoiceToolRegistry = Record<string, VoiceTool>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Voice sibling of `SmsSendError` — classifies a provider call-placement
 * failure so the tracked caller / a provider's retry loop can tell a transient
 * (429 / 5xx / network) fault from a permanent one (bad number, auth). Lives in
 * the authoring package, mirroring where `SmsSendError` lives in `@hogsend/sms`.
 */
export class VoiceCallError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "VoiceCallError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}
