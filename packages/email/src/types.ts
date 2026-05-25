import type { ReactElement } from "react";

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export interface TemplateMap {
  welcome: WelcomeEmailProps;
  "password-reset": PasswordResetEmailProps;
  "journey-notification": JourneyNotificationEmailProps;
  "activation-quickstart": ActivationQuickstartEmailProps;
  "activation-feature-highlight": ActivationFeatureHighlightEmailProps;
  "activation-community": ActivationCommunityEmailProps;
  "activation-nudge": ActivationNudgeEmailProps;
  "conversion-usage-milestone": ConversionUsageMilestoneEmailProps;
  "conversion-trial-expiring": ConversionTrialExpiringEmailProps;
  "conversion-winback-offer": ConversionWinbackOfferEmailProps;
  "retention-achievement": RetentionAchievementEmailProps;
  "retention-weekly-digest": RetentionWeeklyDigestEmailProps;
  "reactivation-checkin": ReactivationCheckinEmailProps;
  "reactivation-final-nudge": ReactivationFinalNudgeEmailProps;
  "feedback-nps-survey": FeedbackNpsSurveyEmailProps;
  "churn-payment-failed": ChurnPaymentFailedEmailProps;
}

export type TemplateName = keyof TemplateMap;

export interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
}

export interface PasswordResetEmailProps {
  name: string;
  resetUrl: string;
  expiresInMinutes?: number;
}

export interface JourneyNotificationEmailProps {
  name: string;
  journeyName: string;
  eventName: string;
  body: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Activation templates
// ---------------------------------------------------------------------------

export interface ActivationQuickstartEmailProps {
  name: string;
  productName?: string;
  quickstartUrl?: string;
  setupSteps?: string[];
  unsubscribeUrl?: string;
}

export interface ActivationFeatureHighlightEmailProps {
  name: string;
  productName?: string;
  featureName?: string;
  featureDescription?: string;
  beforeText?: string;
  afterText?: string;
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl?: string;
}

export interface ActivationCommunityEmailProps {
  name: string;
  productName?: string;
  communityUrl?: string;
  communityName?: string;
  memberCount?: string;
  highlights?: string[];
  unsubscribeUrl?: string;
}

export interface ActivationNudgeEmailProps {
  name: string;
  productName?: string;
  featureName?: string;
  nudgeMessage?: string;
  ctaUrl?: string;
  ctaText?: string;
  helpUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Conversion templates
// ---------------------------------------------------------------------------

export interface ConversionUsageMilestoneEmailProps {
  name: string;
  productName?: string;
  usageCount?: number;
  usageLabel?: string;
  usageLimit?: number;
  proFeatures?: string[];
  upgradeUrl?: string;
  unsubscribeUrl?: string;
}

export interface ConversionTrialExpiringEmailProps {
  name: string;
  productName?: string;
  daysLeft?: number;
  trialEndDate?: string;
  valueSummary?: string[];
  upgradeUrl?: string;
  unsubscribeUrl?: string;
}

export interface ConversionWinbackOfferEmailProps {
  name: string;
  productName?: string;
  discountPercent?: number;
  offerUrl?: string;
  expiresIn?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Retention templates
// ---------------------------------------------------------------------------

export interface RetentionAchievementEmailProps {
  name: string;
  productName?: string;
  achievementName?: string;
  achievementDescription?: string;
  stat?: string;
  previousStat?: string;
  shareUrl?: string;
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl?: string;
}

export interface RetentionWeeklyDigestEmailProps {
  name: string;
  productName?: string;
  periodLabel?: string;
  stats?: Array<{ label: string; value: string; change?: string }>;
  tip?: string;
  communityHighlight?: string;
  dashboardUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Reactivation templates
// ---------------------------------------------------------------------------

export interface ReactivationCheckinEmailProps {
  name: string;
  productName?: string;
  daysSinceActive?: number;
  highlights?: string[];
  returnUrl?: string;
  unsubscribeUrl?: string;
}

export interface ReactivationFinalNudgeEmailProps {
  name: string;
  productName?: string;
  returnUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Feedback templates
// ---------------------------------------------------------------------------

export interface FeedbackNpsSurveyEmailProps {
  name: string;
  productName?: string;
  surveyUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Churn templates
// ---------------------------------------------------------------------------

export interface ChurnPaymentFailedEmailProps {
  name: string;
  productName?: string;
  retryUrl?: string;
  updatePaymentUrl?: string;
  gracePeriodDays?: number;
  unsubscribeUrl?: string;
}

export interface TemplateDefinition<P = Record<string, unknown>> {
  component: (props: P) => ReactElement;
  defaultSubject: string;
  category?: string;
  preview?: (props: P) => string;
}

export type TemplateRegistry = {
  [K in TemplateName]: TemplateDefinition<TemplateMap[K]>;
};

// ---------------------------------------------------------------------------
// Render options
// ---------------------------------------------------------------------------

export interface EmailServiceRenderOptions<
  K extends TemplateName = TemplateName,
> {
  template: K;
  props: TemplateMap[K];
}

export interface EmailServiceRenderResult {
  html: string;
  text: string;
  subject: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { retryable: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "EmailSendError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export class EmailSuppressionError extends Error {
  readonly reason: "unsubscribed" | "suppressed" | "category_unsubscribed";

  constructor(reason: EmailSuppressionError["reason"], email: string) {
    super(`Email to ${email} suppressed: ${reason}`);
    this.name = "EmailSuppressionError";
    this.reason = reason;
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
