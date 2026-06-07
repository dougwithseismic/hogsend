// Module augmentation (Option B) — this is what makes
// `emailService.send({ template, props })` fully type-checked against THIS
// app's templates. `@hogsend/email` ships an empty `TemplateRegistryMap`; here
// we declare each template key and the props its component expects. Keep these
// keys in sync with `./registry.ts`.

import type {
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
  LifecycleFeatureAnnouncementProps,
  LifecycleTrialExpiringProps,
  LifecycleWinBackProps,
  MarketingProductUpdateProps,
  PasswordResetEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  RetentionAchievementEmailProps,
  RetentionWeeklyDigestEmailProps,
  TransactionalMagicLinkProps,
  TransactionalPasswordResetProps,
  TransactionalReceiptProps,
  TransactionalVerifyEmailProps,
  WelcomeEmailProps,
} from "./types.js";

declare module "@hogsend/email" {
  interface TemplateRegistryMap {
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
    "transactional/verify-email": TransactionalVerifyEmailProps;
    "transactional/password-reset": TransactionalPasswordResetProps;
    "transactional/magic-link": TransactionalMagicLinkProps;
    "transactional/receipt": TransactionalReceiptProps;
    "lifecycle/trial-expiring": LifecycleTrialExpiringProps;
    "lifecycle/feature-announcement": LifecycleFeatureAnnouncementProps;
    "lifecycle/win-back": LifecycleWinBackProps;
    "marketing/product-update": MarketingProductUpdateProps;
  }
}
