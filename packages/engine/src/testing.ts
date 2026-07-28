/** Narrow, side-effect-free engine surface used by @hogsend/testing. */

// Type-only side effect: narrows ctx.history.email/sms `template` to the
// registered key unions so the @hogsend/testing harness — and every journey
// test written against it — sees the same union the send path enforces.
import "./journeys/template-key-augmentation.js";

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
  contactKeySql,
  liveContactByCanonicalKey,
} from "./lib/contacts.js";
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
