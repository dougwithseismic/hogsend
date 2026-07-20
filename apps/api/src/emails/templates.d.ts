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
  AdvocacyReviewAskEmailProps,
  BillingUpcomingPaymentEmailProps,
  ChurnPaymentFailedEmailProps,
  ContentWeeklyArticlesEmailProps,
  ConversionTrialExpiringEmailProps,
  ConversionUsageMilestoneEmailProps,
  ConversionWinbackOfferEmailProps,
  EventsQrCheckinEmailProps,
  EventsWereLiveEmailProps,
  FeedbackCsatEmailProps,
  FeedbackDidThisHelpEmailProps,
  FeedbackNpsSurveyEmailProps,
  GroupsAccountDigestEmailProps,
  ImpactJourneyLiftReportEmailProps,
  JourneyNotificationEmailProps,
  MarketingProductUpdateProps,
  OnboardingComeBackToItEmailProps,
  OnboardingNudgeEmailProps,
  OnboardingPersonalizedEmailProps,
  PasswordResetEmailProps,
  PreboardingManagerWelcomeEmailProps,
  ReactivationCheckinEmailProps,
  ReactivationFinalNudgeEmailProps,
  ReengageTipAEmailProps,
  ReengageTipBEmailProps,
  ReengageWebinarEmailProps,
  RetentionAchievementEmailProps,
  RetentionFounderCheckinEmailProps,
  RetentionWeeklyDigestEmailProps,
  SalesProposalOpenedEmailProps,
  SalesWhitepaperFollowUpEmailProps,
  TeamInviteTeammateEmailProps,
  TransactionalMagicLinkProps,
  TransactionalReceiptProps,
  TransactionalVerifyEmailProps,
  WelcomeEmailProps,
  WinbackFinalNoteEmailProps,
  WinbackWhatsNewEmailProps,
} from "./types.js";

declare module "@hogsend/email" {
  interface TemplateRegistryMap {
    "onboarding-personalized": OnboardingPersonalizedEmailProps;
    "onboarding-nudge": OnboardingNudgeEmailProps;
    "reengage-tip-a": ReengageTipAEmailProps;
    "reengage-tip-b": ReengageTipBEmailProps;
    "reengage-webinar": ReengageWebinarEmailProps;
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
    "transactional/magic-link": TransactionalMagicLinkProps;
    "transactional/receipt": TransactionalReceiptProps;
    "marketing/product-update": MarketingProductUpdateProps;
    "billing/upcoming-payment": BillingUpcomingPaymentEmailProps;
    "team/invite-teammate": TeamInviteTeammateEmailProps;
    "content/weekly-articles": ContentWeeklyArticlesEmailProps;
    "sales/proposal-opened": SalesProposalOpenedEmailProps;
    "sales/whitepaper-follow-up": SalesWhitepaperFollowUpEmailProps;
    "events/were-live": EventsWereLiveEmailProps;
    "events/qr-checkin": EventsQrCheckinEmailProps;
    "preboarding/manager-welcome": PreboardingManagerWelcomeEmailProps;
    "onboarding/come-back-to-it": OnboardingComeBackToItEmailProps;
    "retention/founder-checkin": RetentionFounderCheckinEmailProps;
    "winback/whats-new": WinbackWhatsNewEmailProps;
    "winback/final-note": WinbackFinalNoteEmailProps;
    "advocacy/review-ask": AdvocacyReviewAskEmailProps;
    "feedback/csat": FeedbackCsatEmailProps;
    "feedback/did-this-help": FeedbackDidThisHelpEmailProps;
    "impact/journey-lift-report": ImpactJourneyLiftReportEmailProps;
    "groups/account-digest": GroupsAccountDigestEmailProps;
  }
}
