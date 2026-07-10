import type { DefinedJourney, JourneySpec } from "@hogsend/engine";
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
import { retentionWeeklyDigest } from "./retention-weekly-digest.js";
import { specDemoJourney } from "./spec-demo.journey.js";
import { telegramLinkRequest } from "./telegram-link-request.js";
import { telegramLinked } from "./telegram-linked.js";
import { telegramOnboarding } from "./telegram-onboarding.js";
import { telegramWelcome } from "./telegram-welcome.js";
import { testOnboarding } from "./test-onboarding.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 *
 * The array takes BOTH authored `defineJourney` results and declarative
 * {@link JourneySpec} objects (data parsed from JSON/YAML, or typed inline like
 * `spec-demo`) — the engine adapts specs at boot.
 */
export const journeys: Array<DefinedJourney | JourneySpec> = [
  activationWelcome,
  activationNudgeSeries,
  aiOnboarding,
  aiReengagement,
  conversionTrialUpgrade,
  conversionAbandonedCheckout,
  retentionMilestone,
  retentionWeeklyDigest,
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
  specDemoJourney,
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
  retentionWeeklyDigest,
  specDemoJourney,
  telegramLinked,
  telegramLinkRequest,
  telegramOnboarding,
  telegramWelcome,
  testOnboarding,
};
