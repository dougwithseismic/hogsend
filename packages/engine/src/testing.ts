/** Narrow, side-effect-free engine surface used by @hogsend/testing. */

export { JourneyExitedError } from "./journeys/errors.js";
export {
  deriveJourneyKey,
  getJourneyBoundary,
  type JourneyBoundary,
  type JourneyServiceOverrides,
  registerKey,
  registerRecordLabel,
  runWithJourneyBoundary,
} from "./journeys/journey-boundary.js";
export {
  type EnrollmentPolicyFacts,
  type EnrollmentPolicyResult,
  evaluateEnrollmentPolicy,
} from "./lib/enrollment-policy.js";
export { isHeldOut } from "./lib/holdout.js";
export {
  pickVariant,
  validateVariantArms,
  validateVariantKey,
  variantBucket,
} from "./lib/variant.js";
export { isListSubscribed } from "./lists/subscription.js";
