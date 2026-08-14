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
// The account-link store's internal mechanics. These live HERE and not on the
// main barrel on purpose: `packages/engine/src/index.ts` is the committed
// semver boundary, and how the store happens to take advisory locks (or signal
// a stale pre-read) is not a promise to consumers. Tests need them to assert
// lock ORDER, which is the property the whole module exists to guarantee.
export {
  AccountLinkLockSetChangedError,
  lockPairs,
  MAX_VERSION_RACE_RETRIES,
  pairLockKey,
} from "./lib/account-links.js";
// PRD 04's guard + delete-leg tests. `ALL_IDENTITY_KINDS` is the resolver's
// internal full-trust grant (deliberately not public API — the test pinning
// that IdentityKind is never widened reads it here); `softDeleteContact` is
// route-internal on the main barrel, and the delete-leg tests assert on its
// returned `linkUnlinks` facts directly.
export { ALL_IDENTITY_KINDS, softDeleteContact } from "./lib/contacts.js";
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
