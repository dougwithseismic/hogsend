// Prop types for your email templates. These are CONTENT — they live in your
// repo alongside the `.tsx` files and the registry, and you edit them freely.
// The open `TemplateRegistryMap` in `@hogsend/email` is augmented with these in
// `./templates.d.ts`, which is what makes
// `emailService.send({ template, props })` type-check.

export interface WelcomeEmailProps {
  name: string;
  dashboardUrl?: string;
  unsubscribeUrl?: string;
}

export interface ActivationNudgeEmailProps {
  name: string;
  featureName?: string;
  nudgeMessage?: string;
  ctaUrl?: string;
  ctaText?: string;
  helpUrl?: string;
  unsubscribeUrl?: string;
}

// --- Transactional (sent one-off via hs.emails.send / POST /v1/emails) ------

export interface MagicLinkEmailProps {
  /** The one-tap sign-in URL. Required — there's no safe default. */
  loginUrl: string;
  /** Minutes until the link expires (shown in copy). */
  expiresInMinutes?: number;
  /** Optional name for a friendlier greeting. */
  name?: string;
}

export interface ReceiptEmailProps {
  name?: string;
  /** Human invoice/receipt number, e.g. "INV-1024". */
  invoiceNumber: string;
  /** Pre-formatted total incl. currency, e.g. "$49.00". */
  amount: string;
  /** Pre-formatted charge date, e.g. "Jun 7, 2026". */
  date: string;
  /** Line items shown in the receipt table. */
  items?: { description: string; amount: string }[];
  /** Link to the hosted invoice / billing portal. */
  invoiceUrl?: string;
  unsubscribeUrl?: string;
}

// --- Product / lifecycle (sent from journeys) -------------------------------

export interface TrialExpiringEmailProps {
  name?: string;
  /** Days remaining in the trial (drives the copy + preview). */
  daysLeft?: number;
  /** Pre-formatted trial end date, e.g. "Jun 14, 2026". */
  trialEndDate?: string;
  /** "What you've shipped so far" value bullets. */
  valueSummary?: string[];
  upgradeUrl?: string;
  unsubscribeUrl?: string;
}

// --- Marketing (broadcast to a list via hs.campaigns.send) ------------------

export interface ProductUpdateEmailProps {
  name?: string;
  /** Headline of the release / announcement. */
  headline: string;
  /** Short intro paragraph under the headline. */
  intro?: string;
  /** Bullet list of what shipped. */
  highlights?: string[];
  ctaUrl?: string;
  ctaText?: string;
  unsubscribeUrl?: string;
}

export interface FeedbackCheckinEmailProps {
  name: string;
  /**
   * Where the recipient lands after answering. Defaults to the engine-hosted
   * answer page (`HOSTED_ANSWER_HREF`) — pass your own thanks-page URL to
   * land on your site instead.
   */
  landingUrl?: string;
  unsubscribeUrl?: string;
}

// --- AI onboarding (sent from the bundled `ai-onboarding` journey) ----------

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
  /** The feature name to nudge the user towards (set by the agent). */
  featureName?: string;
  ctaText?: string;
  ctaUrl?: string;
  unsubscribeUrl?: string;
}
