// The voice-provider contract lives in the neutral @hogsend/core package. These
// re-exports let `import ... from "@hogsend/plugin-vapi"` resolve the contract
// types without reaching into core directly.
export type {
  JsonSchemaObject,
  StartCallOptions,
  VoiceAgentConfig,
  VoiceAssistantRequest,
  VoiceCallOutcome,
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
  VoiceTranscriptTurn,
  VoiceWebhookParsed,
} from "@hogsend/core";
export { defineVoiceProvider, WebhookHandshakeSignal } from "@hogsend/core";
