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
 */
export function isConfiguredSesEventTopic(
  configured: string | null,
  presented: string,
): boolean {
  return configured !== null && configured === presented;
}
