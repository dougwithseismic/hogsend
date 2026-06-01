// Prop types for this app's email templates. These are CONTENT — they live in
// your repo alongside the `.tsx` files and the registry, and you edit them
// freely. The open `TemplateRegistryMap` in `@hogsend/email` is augmented with
// these in `./templates.d.ts`, which is what makes
// `emailService.send({ template, props })` type-check.

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
