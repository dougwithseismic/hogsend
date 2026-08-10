import type { SubstrateRegion } from "../substrate/types";
import { AwsSesClient } from "./aws";
import { resolveSesRegion, type SesClient } from "./contract";
import { FakeSesClient } from "./fake";
import { SesError } from "./types";

export type {
  AwsSesClientOptions,
  AwsSesCredentials,
  SesCommandLike,
  SesTransport,
  SleepFn,
} from "./aws";
export {
  AWS_SES_ID,
  AwsSesClient,
  classifySesError,
  reputationPolicyArn,
  SES_BACKOFF_BASE_MS,
  SES_BACKOFF_MAX_MS,
  SES_MAX_ATTEMPTS,
  sesBackoffMs,
} from "./aws";
export type { SesClient, SesVerb } from "./contract";
export { resolveSesRegion, SES_VERBS } from "./contract";
export type {
  FakeSesCall,
  FakeSesClientOptions,
  FakeSesConfigurationSetState,
  FakeSesEventDestination,
  FakeSesMethod,
  FakeSesSentMessage,
  FakeSesTenantState,
} from "./fake";
export { FAKE_SES_ID, FakeSesClient } from "./fake";
export * from "./types";

/**
 * The single entry point every caller uses to reach SES.
 *
 * Nothing in the control plane may construct a client directly — go through
 * here, and the choice of implementation stays two environment variables rather
 * than an import graph.
 *
 * ONE CLIENT PER REGION, and that is not a performance decision: SES tenants
 * are region-scoped and do not replicate (DECISIONS §3.3), so a shared client
 * could mint a tenant in a region nobody looks at again.
 */

/**
 * The credentials are read from `process.env` rather than from
 * `apps/cloud/src/env.ts` deliberately, for now: Hogsend Email is optional, and
 * a control plane with no AWS account must boot exactly as it does today. When
 * PRD 01 task 5 adds the two vars to the validated env this reads through to
 * them unchanged — the gate (BOTH present) is the same either way.
 */
const ACCESS_KEY_VAR = "CLOUD_AWS_ACCESS_KEY_ID";
const SECRET_KEY_VAR = "CLOUD_AWS_SECRET_ACCESS_KEY";

/**
 * The fake is a SINGLETON per region, and has to be: its whole state is in
 * memory, so a fresh instance per call would lose every tenant the moment a
 * request ended and local dev could never see a provisioned tenant twice.
 *
 * The AWS client is a singleton for the other reason: stateless, but holding a
 * credential and a connection-reusing transport.
 */
const clients = new Map<SubstrateRegion, SesClient>();

export function getSesClient(region: SubstrateRegion): SesClient {
  // Resolve FIRST: an unmapped region is a refusal, never a cache miss that
  // quietly mints a client for it.
  const awsRegion = resolveSesRegion(region);

  const cached = clients.get(region);
  if (cached) return cached;

  const credentials = readCredentials();
  const client: SesClient = credentials
    ? new AwsSesClient({ region, credentials })
    : new FakeSesClient({ region });

  // One line, once per region, naming which client is live. Mirrors what the
  // engine already does for a missing `RESEND_API_KEY`: an operator must never
  // have to guess whether a deploy is really sending.
  console.log(
    `[cloud:ses] client=${client.id} region=${region} aws_region=${awsRegion}`,
  );
  clients.set(region, client);
  return client;
}

/** Test/dev helper: the process-wide fake for a region, or a throw if the AWS
 * client is the active one. */
export function getFakeSesClient(region: SubstrateRegion): FakeSesClient {
  const client = getSesClient(region);
  if (!(client instanceof FakeSesClient)) {
    throw new SesError(
      `the active SES client for region "${region}" is "${client.id}", not the fake`,
      { kind: "invalid" },
    );
  }
  return client;
}

/** Drop every cached client. Tests only — production holds them for the
 * lifetime of the process. */
export function resetSesClients(): void {
  clients.clear();
}

/**
 * BOTH present → AWS. NEITHER → the Fake, which is the supported default.
 * EXACTLY ONE is a misconfiguration and fails LOUDLY (DECISIONS §7.1): silently
 * degrading to the Fake in production would mean a control plane reporting
 * provisioned tenants and delivered email that never existed.
 */
function readCredentials(): {
  accessKeyId: string;
  secretAccessKey: string;
} | null {
  const accessKeyId = process.env[ACCESS_KEY_VAR]?.trim();
  const secretAccessKey = process.env[SECRET_KEY_VAR]?.trim();

  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
  if (accessKeyId || secretAccessKey) {
    throw new SesError(
      `${ACCESS_KEY_VAR} and ${SECRET_KEY_VAR} must be set together (or neither); refusing to start with half a credential pair`,
      { kind: "invalid" },
    );
  }
  return null;
}
