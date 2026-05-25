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

// Types
export type {
  ActivationCommunityEmailProps,
  ActivationFeatureHighlightEmailProps,
  ActivationNudgeEmailProps,
  ActivationQuickstartEmailProps,
  ChurnPaymentFailedEmailProps,
  ConversionTrialExpiringEmailProps,
  ConversionUsageMilestoneEmailProps,
  ConversionWinbackOfferEmailProps,
  EmailServiceRenderOptions,
  EmailServiceRenderResult,
  FeedbackNpsSurveyEmailProps,
  JourneyNotificationEmailProps,
  PasswordResetEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  RetentionAchievementEmailProps,
  RetentionWeeklyDigestEmailProps,
  RetryOptions,
  TemplateDefinition,
  TemplateMap,
  TemplateName,
  TemplateRegistry,
  WelcomeEmailProps,
} from "./types.js";

// Runtime values & error classes
export {
  DEFAULT_RETRY_OPTIONS,
  EmailSendError,
  EmailSuppressionError,
  WebhookVerificationError,
} from "./types.js";

// Unsubscribe tokens
export type {
  TokenAction,
  TokenOptions,
  UnsubscribeTokenPayload,
} from "./unsubscribe-tokens.js";
export {
  generateUnsubscribeToken,
  InvalidTokenError,
  validateUnsubscribeToken,
} from "./unsubscribe-tokens.js";

// Unsubscribe URLs
export type { UnsubscribeUrlOptions } from "./unsubscribe-url.js";
export {
  generatePreferenceCenterUrl,
  generateUnsubscribeUrl,
} from "./unsubscribe-url.js";
