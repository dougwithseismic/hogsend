// This app's email content. The `templates` registry is passed to
// `createHogsendClient({ email: { templates } })`; `./templates.d.ts` augments
// `@hogsend/email`'s `TemplateRegistryMap` so sends are type-checked.

export { templates } from "./registry.js";

export type {
  ActivationCommunityEmailProps,
  ActivationFeatureHighlightEmailProps,
  ActivationNudgeEmailProps,
  ActivationQuickstartEmailProps,
  ChurnPaymentFailedEmailProps,
  ConversionTrialExpiringEmailProps,
  ConversionUsageMilestoneEmailProps,
  ConversionWinbackOfferEmailProps,
  FeedbackNpsSurveyEmailProps,
  JourneyNotificationEmailProps,
  MarketingProductUpdateProps,
  OnboardingNudgeEmailProps,
  OnboardingPersonalizedEmailProps,
  PasswordResetEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  ReengageTipAEmailProps,
  ReengageTipBEmailProps,
  ReengageWebinarEmailProps,
  RetentionAchievementEmailProps,
  RetentionWeeklyDigestEmailProps,
  TransactionalDiscordLinkCodeProps,
  TransactionalMagicLinkProps,
  TransactionalReceiptProps,
  TransactionalVerifyEmailProps,
  WelcomeEmailProps,
} from "./types.js";
