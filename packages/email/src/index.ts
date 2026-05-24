// Templates (direct imports)
export { default as JourneyNotificationEmail } from "../emails/journey-notification.js";
export { default as PasswordResetEmail } from "../emails/password-reset.js";
export { default as WelcomeEmail } from "../emails/welcome.js";

// Client
export { createResendClient } from "./client.js";
// Template registry
export {
  createRegistry,
  defaultRegistry,
  getPreviewText,
  getTemplate,
  getTemplateDefinition,
  getTemplateNames,
} from "./registry.js";
// Rendering
export { renderToHtml, renderToPlainText } from "./render.js";
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
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  EmailServiceSendOptions,
  EmailServiceWebhookOptions,
  EmailServiceWebhookResult,
  JourneyNotificationEmailProps,
  PasswordResetEmailProps,
  RetryOptions,
  SendEmailOptions,
  SendResult,
  SendTrackedEmailOptions,
  TemplateDefinition,
  TemplateMap,
  TemplateName,
  TemplateRegistry,
  TrackedSendResult,
  WebhookEvent,
  WebhookEventType,
  WebhookHandlerMap,
  WelcomeEmailProps,
} from "./types.js";
// Error classes
export {
  EmailSendError,
  EmailSuppressionError,
  WebhookVerificationError,
} from "./types.js";
// Webhooks
export {
  createWebhookHandler,
  parseWebhookEvent,
  verifyWebhook,
} from "./webhooks.js";
