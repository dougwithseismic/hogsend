/**
 * The live SES delivery proof (PRD 19 tasks 3–4).
 *
 * Not a test, not a CI job — a script a human runs on purpose, against a real
 * AWS account, a running local control plane and a cloudflared quick tunnel,
 * to watch a real simulator bounce travel the WHOLE pipeline: SES → SNS → the
 * control-plane ingress → the signed instance hop → a terminal `email_events`
 * status. It exercises the three verbs PRD 11's walkthrough could never run
 * against AWS: `sendEmail`, `sendBatch` and `putEventDestination`.
 *
 * The entry point is `scripts/ses-delivery-proof.ts`:
 *
 *     pnpm --filter @hogsend/cloud ses:delivery-proof -- --help
 *
 * Everything is exported from here so the guards, the naming, the chain and
 * the report can be proven offline against `FakeSesClient` and injected seams.
 */

export type { ProofOptions, ProofScenario } from "./guards";
export {
  DEFAULT_OBSERVE_SECONDS,
  PROOF_CONFIRMATION_FLAG,
  PROOF_SCENARIOS,
  parseProofArgs,
  proofUsage,
  requireProofConfirmation,
  requirePublicUrl,
  requireSendFrom,
  requireSimulatorRecipient,
  resolveProofTopicArn,
  SIMULATOR_DOMAIN,
  SNS_TOPIC_VAR_BY_REGION,
  simulatorRecipient,
} from "./guards";
export type { ProofNames } from "./naming";
export { PROOF_ENVIRONMENT_PREFIX, proofNames } from "./naming";
export type { ExpectedEvent, ObservedEvent } from "./observe";
export { DEFAULT_POLL_INTERVAL_MS, observeEmailEvents } from "./observe";
export type {
  ExecuteProofInput,
  ExecuteProofResult,
  ProofLink,
  ProofLinkId,
  ProofLinkStatus,
  ProofStep,
} from "./proof";
export {
  executeProof,
  PROOF_LINK_IDS,
  PROOF_LINK_TITLES,
} from "./proof";
export { registerProofStack, unregisterProofStack } from "./registration";
export type { DeliveryProofReport } from "./report";
export { renderProofReport } from "./report";
export type {
  DeliveryProofDeps,
  DeliveryProofRunResult,
} from "./run";
export { runDeliveryProof } from "./run";
export type {
  AwsProofSnsClientOptions,
  ProofSnsClient,
  ProofSubscriptionState,
} from "./sns";
export { awsProofSnsClient } from "./sns";
export type { StubInstance, StubReceipt } from "./stub-instance";
export { startStubInstance } from "./stub-instance";
