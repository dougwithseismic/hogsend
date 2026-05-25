import type { ReactElement } from "react";
import ActivationCommunityEmail from "../emails/activation-community.js";
import ActivationFeatureHighlightEmail from "../emails/activation-feature-highlight.js";
import ActivationNudgeEmail from "../emails/activation-nudge.js";
import ActivationQuickstartEmail from "../emails/activation-quickstart.js";
import ChurnPaymentFailedEmail from "../emails/churn-payment-failed.js";
import ConversionTrialExpiringEmail from "../emails/conversion-trial-expiring.js";
import ConversionUsageMilestoneEmail from "../emails/conversion-usage-milestone.js";
import ConversionWinbackOfferEmail from "../emails/conversion-winback-offer.js";
import FeedbackNpsSurveyEmail from "../emails/feedback-nps-survey.js";
import JourneyNotificationEmail from "../emails/journey-notification.js";
import PasswordResetEmail from "../emails/password-reset.js";
import ReactivationCheckinEmail from "../emails/reactivation-checkin.js";
import ReactivationFinalNudgeEmail from "../emails/reactivation-final-nudge.js";
import RetentionAchievementEmail from "../emails/retention-achievement.js";
import RetentionWeeklyDigestEmail from "../emails/retention-weekly-digest.js";
import WelcomeEmail from "../emails/welcome.js";
import type {
  TemplateDefinition,
  TemplateMap,
  TemplateName,
  TemplateRegistry,
} from "./types.js";

const defaultRegistry: TemplateRegistry = {
  welcome: {
    component: WelcomeEmail,
    defaultSubject: "Welcome to Hogsend",
    category: "transactional",
    preview: (props) => `Welcome to Hogsend, ${props.name}!`,
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

export function getTemplate<K extends TemplateName>(opts: {
  key: K;
  props: TemplateMap[K];
  registry?: TemplateRegistry;
}): { element: ReactElement; subject: string; category?: string } {
  const { key, props, registry = defaultRegistry } = opts;
  const definition = registry[key] as TemplateDefinition<TemplateMap[K]>;

  return {
    element: definition.component(props) as ReactElement,
    subject: definition.defaultSubject,
    category: definition.category,
  };
}

export function getTemplateDefinition<K extends TemplateName>(opts: {
  key: K;
  registry?: TemplateRegistry;
}): TemplateDefinition<TemplateMap[K]> {
  const { key, registry = defaultRegistry } = opts;
  return registry[key] as TemplateDefinition<TemplateMap[K]>;
}

export function getPreviewText<K extends TemplateName>(opts: {
  key: K;
  props: TemplateMap[K];
  registry?: TemplateRegistry;
}): string | undefined {
  const { key, props, registry = defaultRegistry } = opts;
  const definition = registry[key] as TemplateDefinition<TemplateMap[K]>;
  return definition.preview?.(props);
}

export function createRegistry(
  overrides: Partial<TemplateRegistry>,
): TemplateRegistry {
  return { ...defaultRegistry, ...overrides };
}

export function getTemplateNames(
  registry: TemplateRegistry = defaultRegistry,
): TemplateName[] {
  return Object.keys(registry) as TemplateName[];
}

export { defaultRegistry };
