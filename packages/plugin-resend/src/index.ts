// Client
export { createResendClient } from "./client.js";

// Sending (with retry + auto-chunking)
export { sendBatchEmails, sendEmail } from "./send.js";

// Service (high-level DX)
export { createEmailService } from "./service.js";

// Tracked email (DB integration)
export { sendTrackedEmail } from "./tracked.js";
// Types
export type {
  BatchEmailItem,
  EmailBouncedEvent,
  EmailClickedEvent,
  EmailComplainedEvent,
  EmailDeliveredEvent,
  EmailDeliveryDelayedEvent,
  EmailOpenedEvent,
  EmailSentEvent,
  EmailService,
  EmailServiceConfig,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  SendEmailOptions,
  SendResult,
  SendTrackedEmailOptions,
  TrackedSendResult,
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";
export type { WebhookVerifyOptions } from "./webhooks.js";
// Webhooks
export {
  createWebhookHandler,
  parseWebhookEvent,
  verifyWebhook,
} from "./webhooks.js";
