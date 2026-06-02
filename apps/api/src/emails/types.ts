// Prop types for this app's email templates. These are CONTENT — they live in
// your repo alongside the `.tsx` files and the registry, and you edit them
// freely. The open `TemplateRegistryMap` in `@hogsend/email` is augmented with
// these in `./templates.d.ts`, which is what makes
// `emailService.send({ template, props })` type-check.
//
// Note: `sendEmail()` (the journey entry point) always injects `name`,
// `unsubscribeUrl`, `journeyName`, `eventName`, and `body`, so every template
// can rely on those being present.

export interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
  docsUrl?: string;
  unsubscribeUrl?: string;
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
  quickstartUrl?: string;
  docsUrl?: string;
  unsubscribeUrl?: string;
}

export interface ActivationFeatureHighlightEmailProps {
  name: string;
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
  communityUrl?: string;
  communityName?: string;
  memberCount?: string;
  highlights?: string[];
  unsubscribeUrl?: string;
}

export interface ActivationNudgeEmailProps {
  name: string;
  daysSinceSignup?: number;
  setupUrl?: string;
  docsUrl?: string;
  helpUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Conversion templates
// ---------------------------------------------------------------------------

export interface ConversionUsageMilestoneEmailProps {
  name: string;
  usageCount?: number;
  usageLabel?: string;
  usageLimit?: number;
  proFeatures?: string[];
  upgradeUrl?: string;
  unsubscribeUrl?: string;
}

export interface ConversionTrialExpiringEmailProps {
  name: string;
  daysLeft?: number;
  trialEndDate?: string;
  valueSummary?: string[];
  upgradeUrl?: string;
  unsubscribeUrl?: string;
}

export interface ConversionWinbackOfferEmailProps {
  name: string;
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
  daysSinceActive?: number;
  highlights?: string[];
  returnUrl?: string;
  unsubscribeUrl?: string;
}

export interface ReactivationFinalNudgeEmailProps {
  name: string;
  returnUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Feedback templates
// ---------------------------------------------------------------------------

export interface FeedbackNpsSurveyEmailProps {
  name: string;
  surveyUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Churn templates
// ---------------------------------------------------------------------------

export interface ChurnPaymentFailedEmailProps {
  name: string;
  retryUrl?: string;
  updatePaymentUrl?: string;
  gracePeriodDays?: number;
  unsubscribeUrl?: string;
}
