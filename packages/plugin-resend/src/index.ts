// Client
export { createResendClient } from "./client.js";
// Sending-domain capability (Resend Domains REST API)
export {
  createResendDomains,
  type ResendDomainsConfig,
} from "./domains.js";
// EmailProvider (the provider contract + Resend implementation)
export {
  createResendProvider,
  type ResendProviderConfig,
} from "./provider.js";
// Sending (with retry + auto-chunking)
export { sendBatchEmails, sendEmail } from "./send.js";
// Deprecated Resend-shaped union (frozen one minor; cast `event.raw`).
export type {
  BatchEmailItem,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailBouncedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailClickedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailComplainedEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailDeliveredEvent,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailDeliveryDelayedEvent,
  EmailEvent,
  EmailEventType,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailOpenedEvent,
  EmailProvider,
  EmailProviderCapabilities,
  EmailProviderMeta,
  /** @deprecated Use {@link EmailEvent}; cast `event.raw`. */
  EmailSentEvent,
  /** @deprecated Use {@link EmailEvent}. Frozen `event.raw` cast target. */
  LegacyResendWebhookEvent,
  SendEmailOptions,
  SendResult,
  /** @deprecated Use {@link EmailEvent}. Kept for one minor. */
  WebhookEvent,
  /** @deprecated Use {@link EmailEventType}. Kept for one minor. */
  WebhookEventType,
  WebhookHandlerMap,
} from "./types.js";
// Types
export { defineEmailProvider, WebhookHandshakeSignal } from "./types.js";
// Webhooks
export {
  classifyResendBounce,
  createWebhookHandler,
  parseWebhookEvent,
  toEmailEvent,
  verifyWebhook,
} from "./webhooks.js";
