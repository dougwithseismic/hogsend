import {
  paginateListSubscriptionsByTopic,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import type { AwsSesCredentials } from "../../../src/ses/aws";
import type { SesRegion } from "../../../src/ses/types";

/**
 * The three SNS calls the proof needs, and why they are NOT on the SES seam.
 *
 * Same reasoning as `ses-walkthrough/census.ts`, which this module mirrors:
 * `SesClient` is the frozen nineteen-verb SES contract, production never
 * touches SNS subscriptions (the topic is standing infrastructure created by
 * `scripts/aws-bootstrap-events.sh`; only this script attaches an ephemeral
 * tunnel endpoint to it), and widening the seam for a proof script would put
 * two services behind one contract. So this is deliberately the narrowest
 * thing that can do the job:
 *
 *  - **three operations**, `Subscribe`, `ListSubscriptionsByTopic`,
 *    `Unsubscribe` — exactly what the relay user's inline grant
 *    (`HogsendEmailRelayEvents`) allows;
 *  - **same credentials, no new configuration** — the pair the credential
 *    guard already validated;
 *  - **isolated here**, behind an interface a test can fake, so no test ever
 *    constructs the SDK client.
 *
 * Confirmation is polled through `ListSubscriptionsByTopic`, NOT
 * `GetSubscriptionAttributes`: the relay grant scopes its actions to the two
 * TOPIC ARNs, and `GetSubscriptionAttributes` acts on the subscription's own
 * ARN, which that resource list does not match. The list call answers the same
 * question — an unconfirmed subscription reports the literal string
 * `PendingConfirmation` where its ARN would be.
 */

export type ProofSubscriptionState =
  | { status: "confirmed"; subscriptionArn: string }
  | { status: "pending" }
  | { status: "absent" };

export interface ProofSnsClient {
  subscribe(input: { topicArn: string; endpoint: string }): Promise<void>;
  /** This endpoint's subscription on the topic, as the topic listing sees it. */
  findSubscription(input: {
    topicArn: string;
    endpoint: string;
  }): Promise<ProofSubscriptionState>;
  /**
   * AWS authorizes `Unsubscribe` against the subscription's own ARN
   * (`<topic>:<uuid>`), and which form IAM matches is not documented — so the
   * relay grant (`HogsendEmailRelayEvents`, scripts/aws-bootstrap-events.sh)
   * names each topic TWICE, the topic ARN and `<topic>:*`, covering this call
   * whichever one AWS checks. If AWS still refuses it live, the cleanup stack
   * REPORTS it (never swallows it). An unconfirmed subscription needs no
   * removal either way — SNS expires it on its own after three days.
   */
  unsubscribe(input: { subscriptionArn: string }): Promise<void>;
}

/** SNS's placeholder for "not confirmed yet", verbatim. */
const PENDING = "PendingConfirmation";

export interface AwsProofSnsClientOptions {
  awsRegion: SesRegion;
  credentials: AwsSesCredentials;
  /** Read-mostly calls against our own topic; three attempts is plenty. */
  maxAttempts?: number;
}

export function awsProofSnsClient(
  options: AwsProofSnsClientOptions,
): ProofSnsClient {
  const client = new SNSClient({
    region: options.awsRegion,
    maxAttempts: options.maxAttempts ?? 3,
    credentials: options.credentials,
  });

  return {
    async subscribe(input) {
      // No `ReturnSubscriptionArn`: the ARN is read back off the topic listing
      // once the control plane has confirmed, so there is exactly one code
      // path that learns it.
      await client.send(
        new SubscribeCommand({
          TopicArn: input.topicArn,
          Protocol: "https",
          Endpoint: input.endpoint,
        }),
      );
    },

    async findSubscription(input) {
      for await (const page of paginateListSubscriptionsByTopic(
        { client },
        { TopicArn: input.topicArn },
      )) {
        for (const subscription of page.Subscriptions ?? []) {
          if (subscription.Endpoint !== input.endpoint) continue;
          const arn = subscription.SubscriptionArn;
          if (!arn || arn === PENDING) return { status: "pending" };
          return { status: "confirmed", subscriptionArn: arn };
        }
      }
      return { status: "absent" };
    },

    async unsubscribe(input) {
      await client.send(
        new UnsubscribeCommand({ SubscriptionArn: input.subscriptionArn }),
      );
    },
  };
}
