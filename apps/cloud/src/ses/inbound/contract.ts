import type { SubstrateRegion } from "../../substrate/types";
import { SesError, type SesRegion } from "../types";
import {
  SES_INBOUND_ENDPOINT_BY_SES_REGION,
  SES_INBOUND_MAX_RECIPIENTS_PER_RULE,
  SES_INBOUND_RULE_NAME_PATTERN,
  SES_INBOUND_RULE_SET_NAME_PATTERN,
  type SesInboundActiveRuleSet,
  type SesInboundPutRuleInput,
  type SesInboundRule,
  type SesInboundRuleRef,
  type SesInboundRuleSet,
  type SesInboundRuleSetRef,
  type SesInboundSetActiveInput,
  type SesInboundStoreAction,
} from "./types";

/**
 * The SES INBOUND seam: EIGHT verbs, two implementations
 * (`FakeSesInboundClient`, `AwsSesInboundClient`).
 *
 * Enough to provision and tear down inbound receiving for one domain, and
 * nothing else. The verb list is derived from the SES **v1** API reference's
 * own action list; each one carries the reason it is here, and the section at
 * the bottom of this comment carries the reasons the rest are NOT.
 *
 * Every v1 receipt-rule operation states "You can execute this operation no
 * more than once per second" — a far tighter ceiling than the send path's, and
 * the reason the AWS client's backoff matters more here than there.
 *
 * ## Deliberately absent
 *
 *  - `CloneReceiptRuleSet`, `ReorderReceiptRuleSet`, `SetReceiptRulePosition` —
 *    ordering and copying. One rule per domain with disjoint recipient sets
 *    means order decides nothing, and an untested reorder verb is a way to
 *    shuffle a LIVE mail path;
 *  - `ListReceiptRuleSets` — orphan detection after a failed teardown. Our own
 *    database is the register, the same call `ses:ListTenants` gets next door;
 *  - `CreateReceiptFilter` / `DeleteReceiptFilter` / `ListReceiptFilters` — IP
 *    address filters are the OTHER receiving mechanism, account-wide and
 *    IP-based rather than per-domain. A different feature, not this one;
 *  - `SendBounce` — bouncing a message we already received. PRD 16 forwards to
 *    a human; it does not answer on their behalf;
 *  - `UpdateReceiptRule` — not absent. It is the second half of `putRule`.
 *
 * The IAM grant lives in `scripts/aws-bootstrap-events.sh` and is NOT restated
 * here, so the two cannot drift. One thing about it is not derivable from these
 * verb names: `putRule` is not one AWS operation, so it needs BOTH
 * `ses:CreateReceiptRule` and `ses:UpdateReceiptRule`.
 */
export interface SesInboundClient {
  /** `"aws"` | `"fake"` — which implementation answered. */
  readonly id: string;
  /** The jurisdiction the caller asked for. */
  readonly region: SubstrateRegion;
  /** The AWS region it resolves to. */
  readonly awsRegion: SesRegion;
  /**
   * The host a customer's `reply.<domain>` MX record must point at. Resolved
   * through {@link resolveSesInboundEndpoint}, which is its OWN lookup — a
   * region this stack can send from is not evidence that it can receive.
   */
  readonly inboundEndpoint: string;

  // -- Rule set -------------------------------------------------------------

  /**
   * "You must have at least one receipt rule set associated with your account
   * before you can create a receipt rule."
   *
   * NOT idempotent, unlike the outbound `createTenant`: AWS documents
   * `AlreadyExists` and the caller genuinely wants to know, because a rule set
   * that already exists may be somebody else's and may be the ACTIVE one.
   */
  createRuleSet(input: SesInboundRuleSetRef): Promise<void>;
  /**
   * The read-back provisioning is resumable on: it is the only way to tell
   * "already done" from "never ran", and the only way to see which rules a set
   * already holds before adding to it.
   */
  getRuleSet(input: SesInboundRuleSetRef): Promise<SesInboundRuleSet>;
  /**
   * "Deletes the specified receipt rule set and all of the receipt rules it
   * contains." Refuses while the set is ACTIVE — teardown is
   * deactivate-then-delete.
   */
  deleteRuleSet(input: SesInboundRuleSetRef): Promise<void>;

  // -- The one active rule set ----------------------------------------------

  /**
   * What is receiving mail on this account, in this region, right now.
   *
   * The most load-bearing read on the seam. "You can define multiple rule sets
   * for your AWS account, but only one rule set is active at any time" — so
   * activating ours DEACTIVATES whatever was active, for every tenant in the
   * region at once. This is the read that makes that visible BEFORE the write,
   * and it is the inbound analogue of PRD 16's apex-MX guard.
   */
  getActiveRuleSet(): Promise<SesInboundActiveRuleSet>;
  /** A rule set does nothing until it is the active one. `null` disables ALL
   * receiving for the account — see {@link SesInboundSetActiveInput}. */
  setActiveRuleSet(input: SesInboundSetActiveInput): Promise<void>;

  // -- Rule ------------------------------------------------------------------

  /**
   * A PUT — and, like `putEventDestination` next door, the one verb here that
   * is not one AWS operation.
   *
   * SES v1 offers `CreateReceiptRule` and `UpdateReceiptRule` and NO `Put`.
   * Provisioning has to be resumable, so the create-then-update-on-exists dance
   * lives here rather than in every caller. It is a REPLACE, not a merge:
   * `UpdateReceiptRule` takes a whole `ReceiptRule`, so an omitted field is a
   * reset.
   */
  putRule(input: SesInboundPutRuleInput): Promise<void>;
  /**
   * The read-back that proves what SES actually stored — which actions, which
   * recipients, and whether `Enabled` is really true. AWS defaults `Enabled` to
   * FALSE, so a rule can exist and do nothing; without this read a provision
   * cannot tell those two apart.
   */
  getRule(input: SesInboundRuleRef): Promise<SesInboundRule>;
  /** Teardown for ONE domain, without touching the other rules in the set. */
  deleteRule(input: SesInboundRuleRef): Promise<void>;
}

/** Every verb on the seam, minus the four identity properties. */
export type SesInboundVerb = Exclude<
  keyof SesInboundClient,
  "id" | "region" | "awsRegion" | "inboundEndpoint"
>;

/**
 * The verbs, as a runtime value — the same guard `SES_VERBS` provides next
 * door. A verb quietly dropped from the interface takes its callers' behaviour
 * with it and nothing else notices, because a Fake that no longer has a method
 * is just a Fake nobody calls.
 */
export const SES_INBOUND_VERBS = [
  "createRuleSet",
  "getRuleSet",
  "deleteRuleSet",
  "getActiveRuleSet",
  "setActiveRuleSet",
  "putRule",
  "getRule",
  "deleteRule",
] as const satisfies readonly SesInboundVerb[];

/** Compile-time exhaustiveness: adding a verb without listing it is an error. */
type AssertNever<T extends never> = T;
type _EveryVerbIsListed = AssertNever<
  Exclude<SesInboundVerb, (typeof SES_INBOUND_VERBS)[number]>
>;

/**
 * SES region → inbound SMTP host, and a hard refusal for anything else.
 *
 * A SEPARATE lookup from `resolveSesRegion`, and that separation is the point:
 * inbound availability is a strict subset of sending availability, so composing
 * `inbound-smtp.<region>.amazonaws.com` from a region we can send through
 * yields a hostname that resolves to nothing — and the failure surfaces as "the
 * customer's replies never arrive", weeks later, with the MX record looking
 * perfectly correct.
 *
 * Takes a `string` rather than a `SesRegion` for the same reason
 * `resolveSesRegion` does: the value usually arrives from a database column,
 * where the type system has already stopped helping.
 */
export function resolveSesInboundEndpoint(region: string): string {
  const endpoint = (
    SES_INBOUND_ENDPOINT_BY_SES_REGION as Record<string, string | null>
  )[region];
  if (!endpoint) {
    throw new SesError(
      `SES email receiving is not available in region ${JSON.stringify(
        region,
      )}; supported here: ${Object.entries(SES_INBOUND_ENDPOINT_BY_SES_REGION)
        .filter(([, host]) => host)
        .map(([name]) => name)
        .join(", ")}`,
      { kind: "invalid" },
    );
  }
  return endpoint;
}

// ---------------------------------------------------------------------------
// Preconditions, held IDENTICALLY by both implementations
// ---------------------------------------------------------------------------

/**
 * These live on the contract rather than in either client because they are the
 * SEAM's rules, not one implementation's. Two of them refuse things AWS itself
 * accepts; a Fake enforcing a rule the real client does not would be the PRD 14
 * failure in reverse, so both call the same functions.
 */

export function assertRuleSetName(ruleSetName: string): void {
  if (!SES_INBOUND_RULE_SET_NAME_PATTERN.test(ruleSetName)) {
    throw new SesError(
      `invalid receipt rule set name ${JSON.stringify(
        ruleSetName,
      )}: ASCII letters, numbers, underscores or dashes only, starting and ending with a letter or number, 64 characters or fewer (note: NO periods — a rule name may contain one, a rule set name may not)`,
      { kind: "invalid" },
    );
  }
}

export function assertRuleName(ruleName: string): void {
  if (!SES_INBOUND_RULE_NAME_PATTERN.test(ruleName)) {
    throw new SesError(
      `invalid receipt rule name ${JSON.stringify(
        ruleName,
      )}: ASCII letters, numbers, underscores, dashes or periods only, starting and ending with a letter or number, 64 characters or fewer`,
      { kind: "invalid" },
    );
  }
}

/**
 * A rule MUST name its recipients. AWS does not require it; we do.
 *
 * `ReceiptRule.Recipients`, verbatim: "If this field is not specified, this
 * rule matches all recipients on all verified domains." On a multi-tenant
 * account that is one tenant's rule swallowing every other tenant's inbound
 * mail — the receiving twin of the cross-tenant suppression leak the outbound
 * seam exists to prevent, and just as silent. AWS will create it happily; this
 * seam will not.
 */
export function assertRecipients(recipients: string[]): void {
  if (recipients.length === 0) {
    throw new SesError(
      "a receipt rule must name its recipients: SES treats an empty recipient list as 'every recipient on every verified domain', which would route another tenant's inbound mail into this rule",
      { kind: "invalid" },
    );
  }
  if (recipients.length > SES_INBOUND_MAX_RECIPIENTS_PER_RULE) {
    throw new SesError(
      `a receipt rule accepts at most ${SES_INBOUND_MAX_RECIPIENTS_PER_RULE} recipients (unadjustable), got ${recipients.length}`,
      { kind: "invalid" },
    );
  }
}

/**
 * The store action must NOTIFY, not merely store.
 *
 * `S3Action.TopicArn` is optional to AWS, so a rule with a bucket and no topic
 * is legal, creates cleanly, and quietly writes every reply into a bucket
 * nothing ever reads. Storing a reply and telling nobody is indistinguishable
 * from losing it, and the whole point of PRD 16 is the event.
 */
export function assertStoreAction(store: SesInboundStoreAction): void {
  if (!store.bucketName) {
    throw new SesError("a receipt rule's store action needs a bucket name", {
      kind: "invalid",
    });
  }
  if (!store.topicArn) {
    throw new SesError(
      "a receipt rule's store action needs an SNS topic ARN: SES makes it optional, but an S3 action with no notification writes the message somewhere nothing is listening",
      { kind: "invalid" },
    );
  }
}

/** Every precondition a `putRule` has to clear, in one place so the two
 * implementations cannot drift on the order or the messages. */
export function assertPutRuleInput(input: SesInboundPutRuleInput): void {
  assertRuleSetName(input.ruleSetName);
  assertRuleName(input.ruleName);
  assertRecipients(input.recipients);
  assertStoreAction(input.store);
}
