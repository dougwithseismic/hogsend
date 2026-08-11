import { env } from "../env";
import type { SubstrateRegion } from "../substrate/types";

/**
 * The SNS topic each region's SES configuration sets publish to.
 *
 * ONE topic per region rather than one per tenant, because SES tenants are
 * region-scoped (DECISIONS §3.3) and the event carries its own tenant tag —
 * a topic per environment would be thousands of AWS resources to create, keep
 * subscribed and tear down for information already in the payload.
 *
 * Both variables are OPTIONAL, and their absence is a MODE rather than a
 * misconfiguration: a control plane with no AWS account has no topic, and
 * `putEventDestination` is then simply skipped at provision time (the Fake
 * still records everything else). What absence must NEVER mean is "accept any
 * topic" — see {@link isConfiguredSesEventTopic}.
 */
export interface SesEventTopics {
  us: string | null;
  eu: string | null;
}

/** Pure over its input, so the tests and the bound accessor share one rule. */
export function resolveSesEventTopics(vars: {
  CLOUD_SES_SNS_TOPIC_ARN_US?: string;
  CLOUD_SES_SNS_TOPIC_ARN_EU?: string;
}): SesEventTopics {
  return {
    us: vars.CLOUD_SES_SNS_TOPIC_ARN_US ?? null,
    eu: vars.CLOUD_SES_SNS_TOPIC_ARN_EU ?? null,
  };
}

/** The validated env's topics. */
export function sesEventTopics(): SesEventTopics {
  return resolveSesEventTopics(env);
}

/** The topic this region's events arrive on, or null when none is configured. */
export function sesEventTopicArn(region: SubstrateRegion): string | null {
  return sesEventTopics()[region];
}

/**
 * Is this the topic we expect on this endpoint?
 *
 * FAIL CLOSED on `null`. AWS's own guidance is to "reject any message with an
 * unexpected `TopicArn` to prevent spoofing", and with no configured topic
 * there is no such thing as an expected one — so an unconfigured region
 * accepts NOTHING rather than everything. Getting that backwards would turn a
 * missing environment variable into an open bounce-injection endpoint.
 *
 * SHARED by the status ingress and the inbound-receive ingress (PRD 16 task 4),
 * which have different topics and the identical rule. One function rather than
 * two, because the fail-closed arm is the whole value and a second copy is a
 * second chance to write `configured === null || configured === presented`.
 */
export function isConfiguredSnsTopic(
  configured: string | null,
  presented: string,
): boolean {
  return configured !== null && configured === presented;
}

/** {@link isConfiguredSnsTopic}, named for the status wire's callers. */
export const isConfiguredSesEventTopic = isConfiguredSnsTopic;

/**
 * There is deliberately NO `sesInboundTopicArn` accessor here.
 *
 * Inbound has its own topics (`CLOUD_SES_INBOUND_TOPIC_ARN_US|EU`) — a separate
 * one from the status wire, and it has to be: a status event and a received
 * message are different payloads driving different code, and one topic carrying
 * both would make "reject any message with an unexpected TopicArn" mean nothing,
 * because either endpoint would have to accept the other's traffic.
 *
 * But `resolveInboundStore` (`lib/inbound-domains.ts`) already answers "what is
 * this region's inbound topic", TOGETHER with the bucket, and returns null
 * unless BOTH are set. A receipt rule needs both, an S3 action with no topic
 * writes replies into a bucket nothing reads, and a second accessor returning
 * half of that answer is exactly the drift that lets an endpoint accept a
 * message it has nowhere to put.
 */
