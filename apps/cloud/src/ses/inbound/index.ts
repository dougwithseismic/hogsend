import type { SubstrateRegion } from "../../substrate/types";
import { readSesCredentials } from "../index";
import { SesError } from "../types";
import { AwsSesInboundClient } from "./aws";
import type { SesInboundClient } from "./contract";
import { FakeSesInboundClient } from "./fake";

export type { AwsSesInboundClientOptions } from "./aws";
export {
  AWS_SES_INBOUND_ID,
  AwsSesInboundClient,
  classifySesInboundError,
} from "./aws";
export type { SesInboundClient, SesInboundVerb } from "./contract";
export {
  assertRecipients,
  assertRuleName,
  assertRuleSetName,
  assertStoreAction,
  resolveSesInboundEndpoint,
  SES_INBOUND_VERBS,
} from "./contract";
export type {
  FakeSesInboundCall,
  FakeSesInboundClientOptions,
  FakeSesInboundMethod,
} from "./fake";
export { FAKE_SES_INBOUND_ID, FakeSesInboundClient } from "./fake";
export * from "./types";

/**
 * The single entry point every caller uses to reach SES email RECEIVING.
 *
 * Separate from `getSesClient` on purpose, and not merely for tidiness: this
 * one speaks SES v1 over a different SDK, and it can REFUSE a region the
 * outbound factory happily serves. Inbound availability is a strict subset of
 * sending availability, so one shared factory would have to answer "yes" for a
 * region where receiving does not exist.
 *
 * The two seams share exactly two things, and both are visible here: the
 * credentials (`readSesCredentials`, so a half-configured account fails once
 * and loudly rather than twice with different messages) and the
 * `SubstrateRegion → SesRegion` mapping, which the client applies.
 *
 * ONE CLIENT PER REGION, for a sharper reason than the outbound factory's:
 * receipt rule sets are region-scoped AND the active rule set is a per-region,
 * account-wide switch, so a client that could silently target the wrong region
 * would arm — or disarm — receiving somewhere nobody looks again.
 */
const clients = new Map<SubstrateRegion, SesInboundClient>();

export function getSesInboundClient(region: SubstrateRegion): SesInboundClient {
  const cached = clients.get(region);
  if (cached) return cached;

  // The constructor resolves BOTH lookups — substrate → SES region, then SES
  // region → inbound endpoint — so an unmapped region and a region SES cannot
  // receive in are refusals here, never cache misses that quietly mint a
  // client for them.
  const credentials = readSesCredentials();
  const client: SesInboundClient = credentials
    ? new AwsSesInboundClient({ region, credentials })
    : new FakeSesInboundClient({ region });

  // One line, once per region, naming which client is live AND which host the
  // customer's MX has to point at. An operator must never have to guess either,
  // and the MX value is the one thing a customer has to be told correctly.
  console.log(
    `[cloud:ses-inbound] client=${client.id} region=${region} aws_region=${client.awsRegion} mx=${client.inboundEndpoint}`,
  );
  clients.set(region, client);
  return client;
}

/** Test/dev helper: the process-wide fake for a region, or a throw if the AWS
 * client is the active one. */
export function getFakeSesInboundClient(
  region: SubstrateRegion,
): FakeSesInboundClient {
  const client = getSesInboundClient(region);
  if (!(client instanceof FakeSesInboundClient)) {
    throw new SesError(
      `the active SES inbound client for region "${region}" is "${client.id}", not the fake`,
      { kind: "invalid" },
    );
  }
  return client;
}

/** Drop every cached client. Tests only — production holds them for the
 * lifetime of the process. */
export function resetSesInboundClients(): void {
  clients.clear();
}
