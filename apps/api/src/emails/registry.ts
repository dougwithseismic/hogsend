import { type TemplateRegistry, withSources } from "@hogsend/email";
import ActivationCommunityEmail from "./activation-community.js";
import ActivationFeatureHighlightEmail from "./activation-feature-highlight.js";
import ActivationNudgeEmail from "./activation-nudge.js";
import ActivationQuickstartEmail from "./activation-quickstart.js";
import ChurnPaymentFailedEmail from "./churn-payment-failed.js";
import ConversionTrialExpiringEmail from "./conversion-trial-expiring.js";
import ConversionUsageMilestoneEmail from "./conversion-usage-milestone.js";
import ConversionWinbackOfferEmail from "./conversion-winback-offer.js";
import FeedbackNpsSurveyEmail from "./feedback-nps-survey.js";
import JourneyNotificationEmail from "./journey-notification.js";
import MarketingProductUpdateEmail from "./marketing-product-update.js";
import OnboardingNudgeEmail from "./onboarding-nudge.js";
import OnboardingPersonalizedEmail from "./onboarding-personalized.js";
import PasswordResetEmail from "./password-reset.js";
import ReactivationCheckinEmail from "./reactivation-checkin.js";
import ReactivationFinalNudgeEmail from "./reactivation-final-nudge.js";
import ReengageTipAEmail from "./reengage-tip-a.js";
import ReengageTipBEmail from "./reengage-tip-b.js";
import ReengageWebinarEmail from "./reengage-webinar.js";
import RetentionAchievementEmail from "./retention-achievement.js";
import RetentionWeeklyDigestEmail from "./retention-weekly-digest.js";
import TransactionalMagicLinkEmail from "./transactional-magic-link.js";
import TransactionalReceiptEmail from "./transactional-receipt.js";
import TransactionalVerifyEmailEmail from "./transactional-verify-email.js";
import WelcomeEmail from "./welcome.js";

// This app's template registry — CONTENT. Maps each template key to its
// component + default subject + category (+ optional preview text). Passed to
// `createHogsendClient({ email: { templates } })`, which threads it through the engine's
// `TrackedMailer` to `getTemplate(..., { registry })` at send + render time.
//
// These are Hogsend's own dogfood lifecycle emails — the examples shipped with
// the engine. The keys here MUST match the keys augmented into `@hogsend/email`'s
// `TemplateRegistryMap` (see `./templates.d.ts`) for `send({ template, props })`
// to type-check.
//
// `withSources` stamps each definition with its component's source path
// (derived from the key via the flat-file convention) so the Studio can offer
// an "open in editor" link for email nodes. Dev-only + best-effort.
export const templates: TemplateRegistry = withSources(import.meta.dirname, {
  "onboarding-personalized": {
    component: OnboardingPersonalizedEmail,
    defaultSubject: "Welcome — here's where to start",
    category: "journey",
    preview: (props) =>
      `${props.name ?? "there"}, a quick note personalized for you.`,
    examples: {
      name: "Ada",
      body: "Based on your setup, we think you'll get the most value from our journey builder.",
      tips: ["Define your first journey", "Connect your PostHog project"],
    },
  },
  "onboarding-nudge": {
    component: OnboardingNudgeEmail,
    defaultSubject: "Still haven't tried it?",
    category: "journey",
    preview: (props) =>
      `${props.name ?? "there"}, you haven't activated the key feature yet.`,
    examples: { name: "Ada", featureName: "the journey builder" },
  },
  "reengage-tip-a": {
    component: ReengageTipAEmail,
    defaultSubject: "A quick win while you were away",
    category: "journey",
    preview: (props) =>
      `${props.name ?? "there"}, here's a quick win to get more out of Hogsend.`,
    examples: {
      name: "Ada",
      tip: "Set up frequency caps so your journeys never over-mail a contact",
    },
  },
  "reengage-tip-b": {
    component: ReengageTipBEmail,
    defaultSubject: "An advanced pattern you might not have tried",
    category: "journey",
    preview: (props) =>
      `${props.name ?? "there"}, here's an advanced Hogsend pattern worth a look.`,
    examples: {
      name: "Ada",
      useCase: "AI-driven journeys that decide which email to send next",
    },
  },
  "reengage-webinar": {
    component: ReengageWebinarEmail,
    defaultSubject: "Get your first journey live — join us",
    category: "journey",
    preview: (props) =>
      `${props.name ?? "there"}, join us for a live onboarding session.`,
    examples: {
      name: "Ada",
      webinarTitle: "Hogsend Live: Get Your First Journey Running",
      webinarDate: "Thursday, 2 July at 4 pm UTC",
    },
  },
  welcome: {
    component: WelcomeEmail,
    defaultSubject: "Welcome to Hogsend",
    category: "transactional",
    preview: (props) =>
      `Welcome, ${props.name} — lifecycle email as code starts here.`,
    examples: { name: "Ada" },
  },
  "password-reset": {
    component: PasswordResetEmail,
    defaultSubject: "Reset your password",
    category: "transactional",
    preview: () => "Reset your Hogsend password",
  },
  "journey-notification": {
    component: JourneyNotificationEmail,
    defaultSubject: "Journey notification",
    category: "journey",
    preview: (props) => `${props.journeyName}: ${props.eventName}`,
  },
  "activation-quickstart": {
    component: ActivationQuickstartEmail,
    defaultSubject: "Your Hogsend setup guide",
    category: "journey",
    preview: (props) =>
      `${props.name}, get your first journey live in ~5 minutes.`,
    examples: { name: "Ada" },
  },
  "activation-feature-highlight": {
    component: ActivationFeatureHighlightEmail,
    defaultSubject: "Journeys are just TypeScript",
    category: "journey",
    preview: (props) =>
      `${props.name}, here's a Hogsend superpower worth a look`,
  },
  "activation-community": {
    component: ActivationCommunityEmail,
    defaultSubject: "See what other teams are shipping",
    category: "journey",
    preview: (props) => `${props.name}, don't start from a blank file`,
  },
  "activation-nudge": {
    component: ActivationNudgeEmail,
    defaultSubject: "We haven't seen any events yet",
    category: "journey",
    preview: (props) => `${props.name}, is your project connected?`,
  },
  "conversion-usage-milestone": {
    component: ConversionUsageMilestoneEmail,
    defaultSubject: "You've hit a Hogsend milestone",
    category: "journey",
    preview: (props) => `${props.name}, your journeys are doing real work`,
  },
  "conversion-trial-expiring": {
    component: ConversionTrialExpiringEmail,
    defaultSubject: "Your Hogsend Cloud trial is ending soon",
    category: "journey",
    preview: (props) => `${props.name}, keep your journeys live`,
  },
  "conversion-winback-offer": {
    component: ConversionWinbackOfferEmail,
    defaultSubject: "A little something to come back",
    category: "journey",
    preview: (props) => `${props.name}, here's a discount on Hogsend Cloud`,
    examples: { name: "Ada", discountPercent: 25, expiresIn: "48 hours" },
  },
  "retention-achievement": {
    component: RetentionAchievementEmail,
    defaultSubject: "You hit a milestone 🎉",
    category: "journey",
    preview: (props) => `${props.name}, nice work — milestone unlocked`,
  },
  "retention-weekly-digest": {
    component: RetentionWeeklyDigestEmail,
    defaultSubject: "Your Hogsend week",
    category: "journey",
    preview: (props) => `${props.name}, your sends, opens and clicks this week`,
  },
  "reactivation-checkin": {
    component: ReactivationCheckinEmail,
    defaultSubject: "Your project's gone quiet",
    category: "journey",
    preview: (props) => `${props.name}, everything okay over there?`,
  },
  "reactivation-final-nudge": {
    component: ReactivationFinalNudgeEmail,
    defaultSubject: "One last note from Hogsend",
    category: "journey",
    preview: (props) => `${props.name}, we'll leave it here`,
  },
  "feedback-nps-survey": {
    component: FeedbackNpsSurveyEmail,
    defaultSubject: "Quick question — how are we doing?",
    category: "journey",
    preview: (props) => `${props.name}, one quick click`,
  },
  "churn-payment-failed": {
    component: ChurnPaymentFailedEmail,
    defaultSubject: "Your payment didn't go through",
    category: "transactional",
    preview: (props) => `${props.name}, action needed on your billing`,
  },
  // --- Transactional — sent one-off via
  // hs.emails.send / POST /v1/emails. No list, no unsubscribe.
  "transactional/verify-email": {
    component: TransactionalVerifyEmailEmail,
    defaultSubject: "Verify your email address",
    category: "transactional",
    preview: () => "Confirm your email to finish setting up your account",
    examples: {
      name: "Ada",
      verifyUrl: "https://app.hogsend.com/verify?token=demo",
      expiresIn: "24 hours",
    },
  },
  "transactional/magic-link": {
    component: TransactionalMagicLinkEmail,
    defaultSubject: "Your sign-in link",
    category: "transactional",
    preview: () => "Tap to sign in — no password needed",
    examples: {
      name: "Ada",
      magicLinkUrl: "https://app.hogsend.com/auth/magic?token=demo",
      expiresIn: "15 minutes",
    },
  },
  "transactional/receipt": {
    component: TransactionalReceiptEmail,
    defaultSubject: "Your receipt",
    category: "transactional",
    preview: (props) => `Receipt for order ${props.orderId} — ${props.total}`,
    examples: {
      name: "Ada",
      orderId: "HS-10428",
      items: [
        { description: "Hogsend Cloud — Team plan", amount: "$49.00" },
        { description: "Additional seats (2)", amount: "$20.00" },
      ],
      total: "$69.00",
      purchasedAt: "June 7, 2026",
    },
  },

  // --- Marketing — broadcast to a list via
  // hs.campaigns.send. Category is the real `product-updates` list id, so the
  // mailer's suppression check + preference center gate it.
  "marketing/product-update": {
    component: MarketingProductUpdateEmail,
    defaultSubject: "What's new in Hogsend",
    category: "product-updates",
    preview: (props) => props.headline ?? "What's new in Hogsend this month",
    examples: {
      name: "Ada",
      headline: "What shipped in Hogsend this month",
    },
  },
});
