import type { SesRegion } from "../types";

/**
 * THE SES INBOUND seam (PRD 16).
 *
 * A SECOND seam, deliberately, and not a widening of the frozen nineteen-verb
 * `SesClient` next door. Every receipt-rule verb lives in SES **v1**
 * (`@aws-sdk/client-ses`): the v2 action list runs from `BatchGetMetricData` to
 * `UpdateReputationEntityPolicy` and contains NO receipt-rule operation of any
 * kind — email receiving is absent from v2 entirely. Bolting these onto the v2
 * contract would mean one seam standing for two APIs with different clients,
 * different error vocabularies (`RuleSetDoesNotExist`, not `NotFoundException`)
 * and different regional availability, which is exactly how the live proof PRD
 * 21 ran against that contract stops meaning anything.
 *
 * The two seams share exactly two things: the AWS credentials, and
 * `SubstrateRegion → SesRegion`. Everything else here is its own.
 *
 * The house rules carry over unchanged:
 *  - every input and output is a plain, portable value. No SDK command, no
 *    `$metadata`, no AWS enum object crosses the boundary;
 *  - every method is async and single-object-in / result-object-out;
 *  - errors cross as the shared `SesError`, classified by `kind`, because a
 *    caller branching on `kind` must not have to know which API answered.
 *
 * There is deliberately NO timestamp anywhere below. AWS's
 * `ReceiptRuleSetMetadata` carries a `CreatedTimestamp` and nothing above this
 * seam needs it; carrying it would force the Fake to invent a clock, which is
 * the one thing a deterministic fake may not have. Same call the outbound
 * `SesTenant` makes.
 */

// ---------------------------------------------------------------------------
// Region availability — its OWN lookup
// ---------------------------------------------------------------------------

/**
 * `SesRegion` → the SMTP host a customer's inbound MX record points at, or
 * `null` for a region that can SEND but cannot RECEIVE.
 *
 * The `null` arm is the whole point. Inbound availability is a STRICT SUBSET of
 * sending availability: AWS's *Email Receiving endpoints* table lists 22
 * regions where its *Service API endpoints* table lists 29. `ap-south-2`,
 * `ap-southeast-5`, `ca-west-1`, `eu-central-2` and `me-central-1` are in the
 * sending table and absent from the receiving one, and AWS states verbatim
 * "Amazon SES does not support email receiving in the following Regions: AWS
 * GovCloud (US-West) and AWS GovCloud (US-East)".
 *
 * So "this region can send" is NOT evidence that it can receive, and this map
 * exists so nobody can compose `inbound-smtp.<region>.amazonaws.com` from a
 * sending region and get a hostname that resolves to nothing. Typed against
 * `SesRegion`, so adding a third sending region is a COMPILE error here until
 * somebody looks the answer up.
 */
export const SES_INBOUND_ENDPOINT_BY_SES_REGION: Record<
  SesRegion,
  string | null
> = {
  "us-east-1": "inbound-smtp.us-east-1.amazonaws.com",
  "eu-west-1": "inbound-smtp.eu-west-1.amazonaws.com",
};

// ---------------------------------------------------------------------------
// Quotas
// ---------------------------------------------------------------------------

/**
 * The email-receiving quotas, from *Service quotas in Amazon SES*. Every one is
 * "Adjustable: No", which is why they are constants rather than configuration.
 *
 * They are modelled by the Fake because they are real walls a control plane
 * hits at scale, not paperwork: 40 rule sets per account is a hard ceiling on
 * any rule-set-per-tenant design, and 200 rules per set is the ceiling on the
 * one-shared-set design that replaces it.
 */
export const SES_INBOUND_MAX_RULE_SETS = 40;

export const SES_INBOUND_MAX_RULES_PER_RULE_SET = 200;

export const SES_INBOUND_MAX_RECIPIENTS_PER_RULE = 500;

/**
 * Why the action is S3 + SNS and never SNS alone.
 *
 * SNS caps a published message at 150 KB and S3 at 40 MB — both unadjustable —
 * so an SNS-only rule would fail on any real reply carrying a phone photo while
 * passing every hand-written test fixture. These are here to be quoted at the
 * next person who proposes simplifying the action away.
 */
export const SES_INBOUND_MAX_S3_MESSAGE_BYTES = 40 * 1024 * 1024;

export const SES_INBOUND_MAX_SNS_MESSAGE_BYTES = 150 * 1024;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A receipt RULE SET name: ASCII letters, numbers, underscores or dashes;
 * starts and ends with a letter or number; 64 characters or fewer
 * (`CreateReceiptRuleSet`).
 *
 * NOTE what is absent: a PERIOD. A rule name may contain one and a rule set
 * name may not, so a name derived from a domain (`reply.acme.com`) is legal as
 * a rule and rejected as a rule set.
 */
export const SES_INBOUND_RULE_SET_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

/** A receipt RULE name: the set's charset plus periods (`ReceiptRule.Name`). */
export const SES_INBOUND_RULE_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,62}[A-Za-z0-9])?$/;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * `Require` BOUNCES mail that did not arrive over TLS; `Optional` accepts it.
 * AWS's default is `Optional` and so is this seam's — see
 * {@link SES_INBOUND_DEFAULT_TLS_POLICY} for why we do not harden it.
 */
export type SesInboundTlsPolicy = "Require" | "Optional";

/**
 * The S3 + SNS action: store the raw MIME in a bucket, then publish a
 * notification carrying its key.
 *
 * `topicArn` is OPTIONAL in this type because that is AWS's own shape and
 * `getRule` has to report what SES actually holds — including an S3 action a
 * human made in the console with no topic at all. It is nonetheless REQUIRED on
 * every write, enforced identically by both implementations
 * (`assertStoreAction`): storing a reply and telling nobody is
 * indistinguishable from losing it.
 */
export interface SesInboundStoreAction {
  bucketName: string;
  /** Required on write; optional here because a READ must stay honest. */
  topicArn?: string;
  /** Key prefix — "similar to a directory name". */
  objectKeyPrefix?: string;
  /**
   * A customer-managed KMS key. NOTE before reaching for it: SES encrypts with
   * the S3 encryption CLIENT, not S3 server-side encryption, so the reader has
   * to decrypt with that same client — available for Java and Ruby only. On a
   * TypeScript control plane, setting this makes the stored mail unreadable.
   */
  kmsKeyArn?: string;
  /** An IAM role SES assumes for the whole action. Required only for a bucket
   * in a region where receiving is unavailable. */
  iamRoleArn?: string;
}

/**
 * One action on a rule, as READ BACK.
 *
 * The `unsupported` arm is the PRD 14 lesson applied to the read path: a human
 * can add a bounce, Lambda or SNS action in the console, and a read that
 * dropped it would hand a reconciler a rule that looks exactly like the one we
 * wrote. Anything this seam does not model comes back NAMED rather than
 * silently discarded — and never as an AWS SDK object, so the boundary holds.
 *
 * The WRITE side takes exactly one store action instead of this union, for the
 * same reason `SesPutEventDestinationInput` takes SNS only: a union of every
 * action AWS offers would be seven untested branches on a live mail path.
 */
export type SesInboundAction =
  | ({ kind: "store" } & SesInboundStoreAction)
  | { kind: "unsupported"; awsType: string };

export interface SesInboundRule {
  ruleName: string;
  /**
   * The domains and addresses this rule applies to, matched against the SMTP
   * ENVELOPE recipients (`RCPT TO`), never the `To:`/`Cc:` headers.
   *
   * NEVER empty on a rule this seam wrote — see `assertRecipients`.
   */
  recipients: string[];
  actions: SesInboundAction[];
  /** A disabled rule exists, reads back fine, and does nothing at all. */
  enabled: boolean;
  /** Spam/virus scanning. Its verdicts arrive as `X-SES-Spam-Verdict` and
   * `X-SES-Virus-Verdict` headers on the stored MIME. */
  scanEnabled: boolean;
  tlsPolicy: SesInboundTlsPolicy;
}

export interface SesInboundRuleSet {
  ruleSetName: string;
  /** In evaluation ORDER: "all of the receipt rules within your active rule
   * set are applied in the order you've defined". */
  rules: SesInboundRule[];
}

/**
 * The answer to "what is receiving mail on this account right now".
 *
 * `ruleSetName` is absent when NOTHING is active, which is a real state —
 * `SetActiveReceiptRuleSet` with a null name disables receiving account-wide.
 */
export interface SesInboundActiveRuleSet {
  ruleSetName?: string;
  rules: SesInboundRule[];
}

export interface SesInboundRuleSetRef {
  ruleSetName: string;
}

export interface SesInboundRuleRef {
  ruleSetName: string;
  ruleName: string;
}

/**
 * `null` means DISABLE ALL EMAIL RECEIVING for the account in this region.
 *
 * A required field taking `string | null` rather than an optional one, on
 * purpose: AWS models the parameter as "Required: No", so the account-wide
 * off-switch is what you get by FORGETTING to pass a name. Here it is a value
 * somebody typed.
 */
export interface SesInboundSetActiveInput {
  ruleSetName: string | null;
}

/**
 * One rule, written whole.
 *
 * Deliberately NO rule POSITION. `CreateReceiptRule` takes an `After`;
 * `UpdateReceiptRule` takes no such field at all, so a seam that accepted a
 * position would honour it on the first write and silently ignore it on every
 * re-drive — a difference that only shows up as mail matching the wrong rule
 * months later. One rule per domain with disjoint recipient sets makes order
 * decide nothing, so the field buys nothing either.
 */
export interface SesInboundPutRuleInput {
  ruleSetName: string;
  ruleName: string;
  /** REQUIRED and non-empty. See `assertRecipients`. */
  recipients: string[];
  store: SesInboundStoreAction;
  /** Default {@link SES_INBOUND_DEFAULT_ENABLED}. */
  enabled?: boolean;
  /** Default {@link SES_INBOUND_DEFAULT_SCAN_ENABLED}. */
  scanEnabled?: boolean;
  /** Default {@link SES_INBOUND_DEFAULT_TLS_POLICY}. */
  tlsPolicy?: SesInboundTlsPolicy;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * AWS defaults `Enabled` to FALSE. This seam defaults it to TRUE and sends the
 * field on every write.
 *
 * A rule created disabled exists, reads back cleanly, and drops every reply on
 * the floor with no error at any layer — the exact class of silent outage the
 * Fake exists to catch. Nothing here ever relies on AWS's default.
 */
export const SES_INBOUND_DEFAULT_ENABLED = true;

/**
 * Likewise always sent explicitly, and here that is not just belt-and-braces:
 * AWS CONTRADICTS ITSELF about the default. The API reference says
 * "`ScanEnabled` ... The default value is `false`"; the developer guide says
 * "By default SES scans received email content for malware." Sending the field
 * on every write is what makes the contradiction unable to bite us.
 *
 * ON, because PRD 16 requires spam and loop protection, and the scan verdicts
 * are how the receive endpoint learns what it is holding.
 */
export const SES_INBOUND_DEFAULT_SCAN_ENABLED = true;

/**
 * `Optional`, matching AWS, and deliberately NOT hardened to `Require`.
 *
 * `Require` makes SES BOUNCE any message not delivered over TLS. On an outbound
 * path that would be a security win; on this one it silently destroys replies
 * from older senders, and PRD 16's mandate is that a human's reply reaches a
 * human. A lost reply is the failure this feature exists to prevent.
 */
export const SES_INBOUND_DEFAULT_TLS_POLICY: SesInboundTlsPolicy = "Optional";
