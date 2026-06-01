import type { DefinedJourney } from "@hogsend/engine";
import { activationNudgeSeries } from "./activation-nudge-series.js";
import { activationWelcome } from "./activation-welcome.js";
import { churnPrevention } from "./churn-prevention.js";
import { conversionAbandonedCheckout } from "./conversion-abandoned-checkout.js";
import { conversionTrialUpgrade } from "./conversion-trial-upgrade.js";
import { feedbackNps } from "./feedback-nps.js";
import { reactivationDormancy } from "./reactivation-dormancy.js";
import { referralInvite } from "./referral-invite.js";
import { retentionMilestone } from "./retention-milestone.js";
import { testOnboarding } from "./test-onboarding.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 */
export const journeys: DefinedJourney[] = [
  activationWelcome,
  activationNudgeSeries,
  conversionTrialUpgrade,
  conversionAbandonedCheckout,
  retentionMilestone,
  referralInvite,
  feedbackNps,
  reactivationDormancy,
  churnPrevention,
  testOnboarding,
];

// Re-export individual journeys for direct reference (tests, custom wiring).
export {
  activationNudgeSeries,
  activationWelcome,
  churnPrevention,
  conversionAbandonedCheckout,
  conversionTrialUpgrade,
  feedbackNps,
  reactivationDormancy,
  referralInvite,
  retentionMilestone,
  testOnboarding,
};
