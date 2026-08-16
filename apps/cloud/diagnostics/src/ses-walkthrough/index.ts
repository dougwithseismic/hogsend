/**
 * The live SES contract walkthrough (PRD 11).
 *
 * Not a test, not a CI job — a script a human runs on purpose, against a real
 * AWS account, to find out where `FakeSesClient` and AWS disagree. Every test
 * in this stack runs against the Fake, so a place the Fake is wrong is a
 * production-only bug with a green test in front of it.
 *
 * The entry point is `scripts/ses-walkthrough.ts`:
 *
 *     pnpm --filter @hogsend/cloud ses:walkthrough -- --i-know-this-hits-aws
 *
 * Everything is exported from here so the guards, the naming and the
 * comparison logic can be tested without an AWS account.
 */

export type { SenderIdentityCandidate, SesIdentityType } from "./arns";
export {
  domainOfAddress,
  senderIdentityCandidates,
  tenantScopedArn,
} from "./arns";
export type { AwsTenantCensusOptions, TenantCensus } from "./census";
export { awsTenantCensus } from "./census";
export type { CleanupFailure, CleanupReport } from "./cleanup";
export { CleanupStack } from "./cleanup";
export type {
  CompareResult,
  CompareStep,
  Divergence,
  DivergenceReason,
  RecordedStep,
  StepAnswer,
  StepStatus,
} from "./divergence";
export { compareAnswers, DivergenceRecorder } from "./divergence";
export type { AccountCensus, WalkthroughOptions } from "./guards";
export {
  ACCESS_KEY_VAR,
  assertAccountSweepable,
  CONFIRMATION_FLAG,
  parseWalkthroughArgs,
  requireAwsCredentials,
  requireConfirmation,
  SECRET_KEY_VAR,
  WalkthroughRefusal,
  walkthroughUsage,
} from "./guards";
export type { WalkthroughNames } from "./naming";
export {
  DEFAULT_IDENTITY_BASE,
  isWalkthroughTenantName,
  WALKTHROUGH_ENVIRONMENT_PREFIX,
  WALKTHROUGH_EVENT_DESTINATION_NAME,
  WALKTHROUGH_TENANT_PREFIX,
  walkthroughNames,
  walkthroughRunId,
} from "./naming";
export type { WalkthroughReport } from "./report";
export { renderReport, scrub } from "./report";
export type { WalkthroughDeps, WalkthroughRunResult } from "./run";
export { runWalkthrough } from "./run";
export type {
  ExecuteWalkthroughInput,
  ExecuteWalkthroughResult,
  WalkthroughDkim,
} from "./walkthrough";
export { executeWalkthrough } from "./walkthrough";
