import type { DefinedJourney } from "@hogsend/engine";
import { activationNudgeSeries } from "./activation-nudge-series.js";
import { activationWelcome } from "./activation-welcome.js";
import { aiOnboarding } from "./ai-onboarding.js";
import { aiReengagement } from "./ai-reengagement.js";
import { churnPrevention } from "./churn-prevention.js";
import { conversionAbandonedCheckout } from "./conversion-abandoned-checkout.js";
import { conversionTrialUpgrade } from "./conversion-trial-upgrade.js";
import { demoLaunch, demoTrialNudge, demoWelcome } from "./demo-inapp.js";
import { detractorRescue } from "./detractor-rescue.js";
import {
  discordHelloWorld,
  discordHypeHog,
  discordIntroduced,
  discordResonator,
} from "./discord-gamification.js";
import { discordPiglet, discordStranger } from "./discord-lifecycle.js";
import { feedbackNps } from "./feedback-nps.js";
import { linkClickCampaign } from "./link-click-campaign.js";
import { reactivationDormancy } from "./reactivation-dormancy.js";
import { referralInvite } from "./referral-invite.js";
import { retentionMilestone } from "./retention-milestone.js";
import { telegramLinkRequest } from "./telegram-link-request.js";
import { telegramLinked } from "./telegram-linked.js";
import { telegramOnboarding } from "./telegram-onboarding.js";
import { telegramWelcome } from "./telegram-welcome.js";
import { testOnboarding } from "./test-onboarding.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 */
export const journeys: DefinedJourney[] = [
  activationWelcome,
  activationNudgeSeries,
  aiOnboarding,
  aiReengagement,
  conversionTrialUpgrade,
  conversionAbandonedCheckout,
  retentionMilestone,
  referralInvite,
  feedbackNps,
  detractorRescue,
  reactivationDormancy,
  churnPrevention,
  telegramWelcome,
  telegramLinked,
  telegramLinkRequest,
  telegramOnboarding,
  testOnboarding,
  linkClickCampaign,
  discordStranger,
  discordPiglet,
  discordHelloWorld,
  discordIntroduced,
  discordResonator,
  discordHypeHog,
  demoWelcome,
  demoLaunch,
  demoTrialNudge,
];

// Re-export individual journeys for direct reference (tests, custom wiring).
export {
  activationNudgeSeries,
  activationWelcome,
  aiOnboarding,
  aiReengagement,
  churnPrevention,
  conversionAbandonedCheckout,
  conversionTrialUpgrade,
  demoLaunch,
  demoTrialNudge,
  demoWelcome,
  detractorRescue,
  discordHelloWorld,
  discordHypeHog,
  discordIntroduced,
  discordPiglet,
  discordResonator,
  discordStranger,
  feedbackNps,
  linkClickCampaign,
  reactivationDormancy,
  referralInvite,
  retentionMilestone,
  telegramLinked,
  telegramLinkRequest,
  telegramOnboarding,
  telegramWelcome,
  testOnboarding,
};
