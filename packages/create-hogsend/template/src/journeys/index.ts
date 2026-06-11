import type { DefinedJourney } from "@hogsend/engine";
import { feedbackCheckin } from "./feedback-checkin.js";
import { testOnboarding } from "./test-onboarding.js";
import { trialExpiring } from "./trial-expiring.js";
import { welcome } from "./welcome.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 */
export const journeys: DefinedJourney[] = [
  welcome,
  trialExpiring,
  feedbackCheckin,
  testOnboarding,
];

// Re-export individual journeys for direct reference (tests, custom wiring).
export { feedbackCheckin, testOnboarding, trialExpiring, welcome };
