// Client
export { createResendClient } from "./client.js";
// EmailProvider (the provider contract + Resend implementation)
export {
  createResendProvider,
  type ResendProviderConfig,
} from "./provider.js";
// Sending (with retry + auto-chunking)
export { sendBatchEmails, sendEmail } from "./send.js";
// Types
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
} from "./types.js";
// Webhooks
export {
  createWebhookHandler,
  parseWebhookEvent,
  verifyWebhook,
} from "./webhooks.js";
