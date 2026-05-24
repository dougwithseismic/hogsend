// Templates (direct imports)
export { default as ActivationCommunityEmail } from "../emails/activation-community.js";
export { default as ActivationFeatureHighlightEmail } from "../emails/activation-feature-highlight.js";
export { default as ActivationNudgeEmail } from "../emails/activation-nudge.js";
export { default as ActivationQuickstartEmail } from "../emails/activation-quickstart.js";
export { default as ChurnPaymentFailedEmail } from "../emails/churn-payment-failed.js";
export { default as ConversionTrialExpiringEmail } from "../emails/conversion-trial-expiring.js";
export { default as ConversionUsageMilestoneEmail } from "../emails/conversion-usage-milestone.js";
export { default as ConversionWinbackOfferEmail } from "../emails/conversion-winback-offer.js";
export { default as FeedbackNpsSurveyEmail } from "../emails/feedback-nps-survey.js";
export { default as JourneyNotificationEmail } from "../emails/journey-notification.js";
export { default as PasswordResetEmail } from "../emails/password-reset.js";
export { default as ReactivationCheckinEmail } from "../emails/reactivation-checkin.js";
export { default as ReactivationFinalNudgeEmail } from "../emails/reactivation-final-nudge.js";
export { default as RetentionAchievementEmail } from "../emails/retention-achievement.js";
export { default as RetentionWeeklyDigestEmail } from "../emails/retention-weekly-digest.js";
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
  ActivationCommunityEmailProps,
  ActivationFeatureHighlightEmailProps,
  ActivationNudgeEmailProps,
  ActivationQuickstartEmailProps,
  BatchEmailItem,
  ChurnPaymentFailedEmailProps,
  ConversionTrialExpiringEmailProps,
  ConversionUsageMilestoneEmailProps,
  ConversionWinbackOfferEmailProps,
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
  FeedbackNpsSurveyEmailProps,
  JourneyNotificationEmailProps,
  PasswordResetEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  RetentionAchievementEmailProps,
  RetentionWeeklyDigestEmailProps,
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
export type {
  TokenAction,
  TokenOptions,
  UnsubscribeTokenPayload,
} from "./unsubscribe-tokens.js";
// Unsubscribe tokens
export {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "./unsubscribe-tokens.js";
export type { UnsubscribeUrlOptions } from "./unsubscribe-url.js";
// Unsubscribe URLs
export {
  generatePreferenceCenterUrl,
  generateUnsubscribeUrl,
} from "./unsubscribe-url.js";
// Webhooks
export {
  createWebhookHandler,
  parseWebhookEvent,
  verifyWebhook,
} from "./webhooks.js";
