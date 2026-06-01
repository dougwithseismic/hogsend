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
  PasswordResetEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  RetentionAchievementEmailProps,
  RetentionWeeklyDigestEmailProps,
  WelcomeEmailProps,
} from "./types.js";
