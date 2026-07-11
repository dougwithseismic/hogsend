// The SMS-provider contract lives in the neutral @hogsend/core package. These
// re-exports let `import ... from "@hogsend/plugin-twilio"` resolve the contract
// types without reaching into core directly.
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
} from "@hogsend/core";
export { defineSmsProvider, WebhookHandshakeSignal } from "@hogsend/core";
