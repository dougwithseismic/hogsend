import type { DefinedJourney } from "@hogsend/engine/journeys";
import { testOnboarding } from "./test-onboarding.js";
import { welcome } from "./welcome.js";

/**
 * All defined journeys for this app. Passed to `createHogsendClient({ journeys })`
 * and `createWorker({ journeys })`. Edit freely — this is your content.
 */
export const journeys: DefinedJourney[] = [welcome, testOnboarding];

// Re-export individual journeys for direct reference (tests, custom wiring).
export { testOnboarding, welcome };
