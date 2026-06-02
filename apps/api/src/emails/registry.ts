import type { TemplateRegistry } from "@hogsend/email";
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
import PasswordResetEmail from "./password-reset.js";
import ReactivationCheckinEmail from "./reactivation-checkin.js";
import ReactivationFinalNudgeEmail from "./reactivation-final-nudge.js";
import RetentionAchievementEmail from "./retention-achievement.js";
import RetentionWeeklyDigestEmail from "./retention-weekly-digest.js";
import WelcomeEmail from "./welcome.js";

// This app's template registry — CONTENT. Maps each template key to its
// component + default subject + category (+ optional preview text). Passed to
// `createHogsendClient({ email: { templates } })`, which threads it through the engine's
// `TrackedMailer` to `getTemplate(..., { registry })` at send + render time.
//
// The keys here MUST match the keys augmented into `@hogsend/email`'s
// `TemplateRegistryMap` (see `./templates.d.ts`) for `send({ template, props })`
// to type-check.
export const templates: TemplateRegistry = {
  welcome: {
    component: WelcomeEmail,
    defaultSubject: "Welcome to Hogsend",
    category: "transactional",
    preview: (props) => `Welcome to Hogsend, ${props.name}!`,
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
    defaultSubject: "Welcome — let's get you set up",
    category: "journey",
    preview: (props) => `Welcome, ${props.name}! Get set up in 5 minutes.`,
    examples: { name: "Ada" },
  },
  "activation-feature-highlight": {
    component: ActivationFeatureHighlightEmail,
    defaultSubject: "Have you tried this yet?",
    category: "journey",
    preview: (props) => `${props.name}, check out what this feature can do`,
  },
  "activation-community": {
    component: ActivationCommunityEmail,
    defaultSubject: "Join the community",
    category: "journey",
    preview: (props) => `${props.name}, join the community`,
  },
  "activation-nudge": {
    component: ActivationNudgeEmail,
    defaultSubject: "You haven't tried the key feature yet",
    category: "journey",
    preview: (props) => `${props.name}, you're missing out`,
  },
  "conversion-usage-milestone": {
    component: ConversionUsageMilestoneEmail,
    defaultSubject: "You're on a roll — here's what's next",
    category: "journey",
    preview: (props) => `${props.name}, you've hit a milestone`,
  },
  "conversion-trial-expiring": {
    component: ConversionTrialExpiringEmail,
    defaultSubject: "Your trial is ending soon",
    category: "journey",
    preview: (props) => `${props.name}, your trial ends soon`,
  },
  "conversion-winback-offer": {
    component: ConversionWinbackOfferEmail,
    defaultSubject: "We'd love to have you back",
    category: "journey",
    preview: (props) => `${props.name}, here's a special offer`,
    examples: { name: "Ada", discountPercent: 25, expiresIn: "48 hours" },
  },
  "retention-achievement": {
    component: RetentionAchievementEmail,
    defaultSubject: "Congratulations on your achievement!",
    category: "journey",
    preview: (props) => `${props.name}, you hit a milestone!`,
  },
  "retention-weekly-digest": {
    component: RetentionWeeklyDigestEmail,
    defaultSubject: "Your weekly snapshot",
    category: "journey",
    preview: (props) => `${props.name}, here's your week in review`,
  },
  "reactivation-checkin": {
    component: ReactivationCheckinEmail,
    defaultSubject: "We haven't seen you in a while",
    category: "journey",
    preview: (props) => `${props.name}, everything okay?`,
  },
  "reactivation-final-nudge": {
    component: ReactivationFinalNudgeEmail,
    defaultSubject: "One last note",
    category: "journey",
    preview: (props) => `${props.name}, this is our last email`,
  },
  "feedback-nps-survey": {
    component: FeedbackNpsSurveyEmail,
    defaultSubject: "Quick question — how are we doing?",
    category: "journey",
    preview: (props) => `${props.name}, one quick question`,
  },
  "churn-payment-failed": {
    component: ChurnPaymentFailedEmail,
    defaultSubject: "Your payment didn't go through",
    category: "transactional",
    preview: (props) => `${props.name}, action needed on your account`,
  },
};
