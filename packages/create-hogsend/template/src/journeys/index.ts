import type { DefinedJourney } from "@hogsend/engine/journeys";
import { aiOnboarding } from "./ai-onboarding.js";
import { feedbackCheckin } from "./feedback-checkin.js";
import { testOnboarding } from "./test-onboarding.js";
import { trialExpiring } from "./trial-expiring.js";
import { welcome } from "./welcome.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 *
 * `aiOnboarding` requires ANTHROPIC_API_KEY — set it in .env (see .env.example)
 * or remove the journey if you're not using the AI tier yet.
 */
export const journeys: DefinedJourney[] = [
  aiOnboarding,
  welcome,
  trialExpiring,
  feedbackCheckin,
  testOnboarding,
];

// Re-export individual journeys for direct reference (tests, custom wiring).
export {
  aiOnboarding,
  feedbackCheckin,
  testOnboarding,
  trialExpiring,
  welcome,
};
