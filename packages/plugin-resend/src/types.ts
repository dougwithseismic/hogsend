// The email-provider contract now lives in the neutral @hogsend/core package.
// These re-exports keep every existing `import ... from "@hogsend/plugin-resend"`
// working unchanged.
export type {
  BatchEmailItem,
  EmailBouncedEvent,
  EmailClickedEvent,
  EmailComplainedEvent,
  EmailDeliveredEvent,
  EmailDeliveryDelayedEvent,
  EmailOpenedEvent,
  EmailProvider,
  EmailSentEvent,
  SendEmailOptions,
  SendResult,
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "@hogsend/core";
