// Client

// Agent mapping (neutral VoiceAgentConfig → Vapi transient assistant)
export { toVapiAssistant } from "./agent-mapping.js";
export { createVapiClient, type VapiClient } from "./client.js";
// VoiceProvider (the provider contract + Vapi implementation)
export {
  createVapiProvider,
  type VapiProviderConfig,
} from "./provider.js";
// Placing calls (with retry + error classification)
export { startCall, type VapiRetryOptions } from "./send.js";
// Contract types (re-exported from @hogsend/core)
export type {
  StartCallOptions,
  VoiceAgentConfig,
  VoiceEvent,
  VoiceEventType,
  VoiceFailureClass,
  VoiceProvider,
  VoiceProviderCapabilities,
  VoiceProviderMeta,
  VoiceStartResult,
  VoiceToolCall,
  VoiceToolResult,
  VoiceToolSpec,
  VoiceWebhookParsed,
} from "./types.js";
export { defineVoiceProvider, WebhookHandshakeSignal } from "./types.js";
// Webhooks
export {
  encodeToolResults,
  parseWebhook,
  toVoiceWebhook,
  verifyWebhook,
} from "./webhooks.js";
