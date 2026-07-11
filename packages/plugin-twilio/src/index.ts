// Client
export { createTwilioClient } from "./client.js";
// SmsProvider (the provider contract + Twilio implementation)
export {
  createTwilioProvider,
  type TwilioProviderConfig,
} from "./provider.js";
// Sending (with retry + error classification)
export { sendSms, type TwilioRetryOptions } from "./send.js";
// Contract types (re-exported from @hogsend/core)
export type {
  SendSmsOptions,
  SmsEvent,
  SmsEventType,
  SmsFailureClass,
  SmsProvider,
  SmsProviderCapabilities,
  SmsProviderMeta,
  SmsSendResult,
  SmsWebhookHandlerMap,
} from "./types.js";
export { defineSmsProvider, WebhookHandshakeSignal } from "./types.js";
// Webhooks
export { parseWebhook, toSmsEvent, verifyWebhook } from "./webhooks.js";
