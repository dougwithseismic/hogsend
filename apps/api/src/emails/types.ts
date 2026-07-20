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
// AI onboarding templates
// ---------------------------------------------------------------------------

export interface OnboardingPersonalizedEmailProps {
  name: string;
  /** The AI-drafted email subject (used by the mailer, not rendered in body). */
  subject?: string;
  /** AI-drafted body paragraph shown below the title. */
  body?: string;
  /** Optional list of personalised tips rendered in a callout block. */
  tips?: string[];
  ctaText?: string;
  ctaUrl?: string;
  unsubscribeUrl?: string;
}

export interface OnboardingNudgeEmailProps {
  name: string;
  /** The feature name to nudge the user towards. */
  featureName?: string;
  ctaText?: string;
  ctaUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Re-engagement templates
// ---------------------------------------------------------------------------

export interface ReengageTipAEmailProps {
  name: string;
  /** The quick-win tip to highlight. */
  tip?: string;
  /** Optional detail or supporting context for the tip. */
  tipDetail?: string;
  ctaText?: string;
  ctaUrl?: string;
  unsubscribeUrl?: string;
}

export interface ReengageTipBEmailProps {
  name: string;
  /** The advanced use case to highlight. */
  useCase?: string;
  /** Optional detail or supporting context for the use case. */
  useCaseDetail?: string;
  ctaText?: string;
  ctaUrl?: string;
  unsubscribeUrl?: string;
}

export interface ReengageWebinarEmailProps {
  name: string;
  /** Title of the webinar or live session. */
  webinarTitle?: string;
  /** Human-readable date/time string for the webinar. */
  webinarDate?: string;
  /** Short description of what the session covers. */
  webinarDescription?: string;
  /** Registration or calendar URL. */
  registerUrl?: string;
  ctaText?: string;
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

// ---------------------------------------------------------------------------
// Transactional templates (sent one-off via hs.emails.send / POST /v1/emails).
// One-off, system-triggered mail — no unsubscribe, no list.
// ---------------------------------------------------------------------------

export interface TransactionalVerifyEmailProps {
  name?: string;
  verifyUrl: string;
  expiresIn?: string;
}

export interface TransactionalMagicLinkProps {
  name?: string;
  magicLinkUrl: string;
  expiresIn?: string;
}

export interface TransactionalReceiptProps {
  name?: string;
  orderId: string;
  items: Array<{ description: string; amount: string }>;
  total: string;
  receiptUrl?: string;
  purchasedAt?: string;
}

// ---------------------------------------------------------------------------
// Marketing templates (broadcast to a list via hs.campaigns.send).
// Gated on the `product-updates` list category.
// ---------------------------------------------------------------------------

export interface MarketingProductUpdateProps {
  name?: string;
  headline?: string;
  body?: string;
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl?: string;
  preferencesUrl?: string;
}

// ---------------------------------------------------------------------------
// Billing templates
// ---------------------------------------------------------------------------

export interface BillingUpcomingPaymentEmailProps {
  name: string;
  planName?: string;
  amount?: string;
  renewalDate?: string;
  cardLast4?: string;
  manageBillingUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Team templates
// ---------------------------------------------------------------------------

export interface TeamInviteTeammateEmailProps {
  name: string;
  seatsAvailable?: number;
  inviteUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Content templates
// ---------------------------------------------------------------------------

export interface ContentWeeklyArticlesEmailProps {
  name: string;
  periodLabel?: string;
  articles?: Array<{ title: string; url: string; minutes?: number }>;
  browseUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Sales templates (playbook: proposal-opened, whitepaper-reader-signals)
// ---------------------------------------------------------------------------

export interface SalesProposalOpenedEmailProps {
  /** The rep receiving the internal alert. */
  name: string;
  prospectName?: string;
  proposalTitle?: string;
  openCount?: number;
  openedAt?: string;
  dealUrl?: string;
}

export interface SalesWhitepaperFollowUpEmailProps {
  name: string;
  whitepaperTitle?: string;
  pricingUrl?: string;
  caseStudyUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Event templates (playbook: live-event-summon; QR check-in)
// ---------------------------------------------------------------------------

export interface EventsWereLiveEmailProps {
  name: string;
  eventTitle?: string;
  joinUrl?: string;
  unsubscribeUrl?: string;
}

export interface EventsQrCheckinEmailProps {
  name: string;
  eventTitle?: string;
  eventDate?: string;
  venue?: string;
  /** Tracked QR image minted via the links API — each scan is a recorded click. */
  qrImageUrl?: string;
  ticketUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Pre-boarding templates (playbook: pre-boarding-sequence)
// ---------------------------------------------------------------------------

export interface PreboardingManagerWelcomeEmailProps {
  /** The new hire. */
  name: string;
  managerName?: string;
  managerEmail?: string;
  teamName?: string;
  startDate?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Onboarding rescue (playbook: second-session-rescue)
// ---------------------------------------------------------------------------

export interface OnboardingComeBackToItEmailProps {
  name: string;
  lastStepLabel?: string;
  resumeUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Retention founder check-in (playbook: usage-drop-early-warning)
// ---------------------------------------------------------------------------

export interface RetentionFounderCheckinEmailProps {
  name: string;
  founderName?: string;
  founderEmail?: string;
  usageObservation?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Winback pair (playbook: dormant-user-winback)
// ---------------------------------------------------------------------------

export interface WinbackWhatsNewEmailProps {
  name: string;
  monthsAway?: number;
  updates?: string[];
  returnUrl?: string;
  unsubscribeUrl?: string;
}

export interface WinbackFinalNoteEmailProps {
  name: string;
  returnUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Advocacy (playbook: post-win-review-ask)
// ---------------------------------------------------------------------------

export interface AdvocacyReviewAskEmailProps {
  name: string;
  winDescription?: string;
  platformName?: string;
  reviewUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Feedback surveys (Survey component — one-click answers as events)
// ---------------------------------------------------------------------------

export interface FeedbackCsatEmailProps {
  name: string;
  /** What's being rated, e.g. "your support conversation yesterday". */
  interactionLabel?: string;
  unsubscribeUrl?: string;
}

export interface FeedbackDidThisHelpEmailProps {
  name: string;
  /** What's being judged, e.g. "the setup guide". */
  subjectLabel?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Impact report (holdouts + journey lift, stakeholder-facing)
// ---------------------------------------------------------------------------

export interface ImpactJourneyLiftReportEmailProps {
  name: string;
  journeyName?: string;
  periodLabel?: string;
  liftPercent?: string;
  winProbability?: string;
  holdoutPercent?: string;
  enrolledConversion?: string;
  holdoutConversion?: string;
  reportUrl?: string;
  unsubscribeUrl?: string;
}

// ---------------------------------------------------------------------------
// Groups (account-level digest for the team owner)
// ---------------------------------------------------------------------------

export interface GroupsAccountDigestEmailProps {
  name: string;
  groupName?: string;
  periodLabel?: string;
  stats?: Array<{ label: string; value: string; change?: string }>;
  quietSeats?: number;
  dashboardUrl?: string;
  unsubscribeUrl?: string;
}
