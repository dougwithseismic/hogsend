import type { SubstrateRegion } from "../substrate/types";

/**
 * THE SES seam (PRD 02 / DECISIONS §3).
 *
 * `apps/cloud/src/ses` is the ONLY place in the repository that talks to AWS.
 * Everything above it — the provisioning pipeline, the relay route, the
 * reputation sweep — sees the neutral types in this file and nothing else,
 * which is what makes PRDs 03–10 testable with no network.
 *
 * The same two rules the substrate and billing seams hold apply here:
 *  - every input and output is a plain, portable value. No SDK command, no
 *    `$metadata`, no AWS enum object crosses the boundary;
 *  - every method is async and single-object-in / result-object-out, so a new
 *    field is an additive change rather than a signature break.
 *
 * The vocabulary is OURS, not AWS's — nineteen verbs named for what this stack
 * does. Where a value is a small closed set that AWS also owns (sending status,
 * suppression scope, DKIM status) the literal strings match AWS's, because
 * inventing a second spelling of `ENABLED` would buy nothing and cost a
 * translation table in both directions.
 */

/**
 * The two SES regions this stack uses. Derived from `SubstrateRegion`, never
 * separately configured (DECISIONS §3.3): a tenant is minted in exactly one
 * region and pinned there for life, because SES tenants do not replicate.
 */
export type SesRegion = "us-east-1" | "eu-west-1";

/** The whole mapping. Anything not in it is a rejected region, not a default. */
export const SES_REGION_BY_SUBSTRATE_REGION: Record<
  SubstrateRegion,
  SesRegion
> = {
  us: "us-east-1",
  eu: "eu-west-1",
};

/**
 * How a failure is classified. Callers branch on `kind`, NEVER on a message
 * string — AWS rewords its messages and a substring match is a silent
 * regression waiting for a release note nobody reads.
 *
 *  - `not_found`      the tenant / identity / configuration set is not there;
 *  - `already_exists` it is there already (only `createTenant` treats this as
 *                     success — see `SesClient.createTenant`);
 *  - `throttled`      SES asked us to slow down. Retryable;
 *  - `account_paused` OUR account's sending is suspended — every tenant is
 *                     down, and no amount of retrying fixes it;
 *  - `tenant_paused`  ONE tenant is paused (DECISIONS §6: fail closed, loudly,
 *                     never rerouted);
 *  - `invalid`        the request was wrong and will be wrong forever;
 *  - `transient`      a 5xx, a network fault, or retries exhausted;
 *  - `unknown`        unrecognised. Deliberately NOT retryable: the default has
 *                     to be "do not repeat an operation we do not understand".
 */
export type SesErrorKind =
  | "not_found"
  | "already_exists"
  | "throttled"
  | "account_paused"
  | "tenant_paused"
  | "invalid"
  | "transient"
  | "unknown";

/**
 * The only two kinds worth another attempt. Everything else is permanent, and
 * the seam's default is "do not retry" for the same reason `SubstrateError`
 * defaults `retryable` to false: retrying a permanent failure burns the
 * pipeline's attempt budget for nothing, and on a SEND it risks a duplicate
 * delivery.
 */
export const SES_RETRYABLE_KINDS: readonly SesErrorKind[] = [
  "throttled",
  "transient",
];

export interface SesErrorOptions {
  kind?: SesErrorKind;
  /** The contract verb that failed — `createTenant`, `sendEmail`, … */
  operation?: string;
  /**
   * The AWS response body, verbatim (bounded). NEVER discarded: a provision
   * that failed at 03:00 has to be diagnosable from this line alone, and
   * "BadRequestException" without the body says nothing at all.
   */
  detail?: string;
  awsErrorName?: string;
  httpStatusCode?: number;
  /** AWS request id, for a support ticket. */
  requestId?: string;
  cause?: unknown;
}

/** The only error type that crosses the seam. */
export class SesError extends Error {
  readonly kind: SesErrorKind;
  readonly retryable: boolean;
  readonly operation: string | undefined;
  readonly detail: string | undefined;
  readonly awsErrorName: string | undefined;
  readonly httpStatusCode: number | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: SesErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.kind = options.kind ?? "unknown";
    // Derived, never passed in: two callers disagreeing about whether a
    // `throttled` is retryable is exactly the bug this seam exists to prevent.
    this.retryable = SES_RETRYABLE_KINDS.includes(this.kind);
    this.operation = options.operation;
    this.detail = options.detail;
    this.awsErrorName = options.awsErrorName;
    this.httpStatusCode = options.httpStatusCode;
    this.requestId = options.requestId;
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** A tag SES attaches to the message and echoes on its event notifications. */
export interface SesMessageTag {
  name: string;
  value: string;
}

/**
 * One outbound message. HTML and text arrive already RENDERED — the engine's
 * tracked mailer owns templates, preferences, first-party tracking and the
 * `email_sends` row, and this seam is the dumb wire underneath it.
 */
export interface SesMessage {
  /** RFC 5322 from, with or without a display name. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  /** Extra headers (`List-Unsubscribe`, …). */
  headers?: Record<string, string>;
  tags?: SesMessageTag[];
}

export interface SesSendEmailInput {
  /**
   * REQUIRED. A send with no tenant lands on the account and every isolation
   * guarantee in DECISIONS §3.2 quietly evaporates — per-tenant reputation,
   * per-tenant suppression, per-tenant pause.
   */
  tenantName: string;
  configurationSetName?: string;
  message: SesMessage;
}

export interface SesSendEmailResult {
  messageId: string;
}

export interface SesSendBatchInput {
  tenantName: string;
  configurationSetName?: string;
  messages: SesMessage[];
}

/**
 * One result per input message, in input order. A batch is NOT all-or-nothing:
 * one unroutable address must not cost the rest of the batch its delivery.
 */
export type SesBatchEntryResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; kind: SesErrorKind; message: string; detail?: string };

export interface SesSendBatchResult {
  results: SesBatchEntryResult[];
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/** `ENABLED` | `DISABLED` (paused) | `REINSTATED` (paused, then let back on). */
export type SesSendingStatus = "ENABLED" | "DISABLED" | "REINSTATED";

/**
 * Whose suppression list a bounce lands on. `TENANT` is the isolation
 * primitive: one tenant's hard bounce must never suppress that address for
 * everybody else on the account.
 */
export type SesSuppressionScope = "ACCOUNT" | "TENANT";

export type SesSuppressionReason = "BOUNCE" | "COMPLAINT";

/**
 * A tenant, as this stack cares about it.
 *
 * Deliberately no `createdAt`: nothing above the seam needs it, and carrying it
 * would force the Fake to invent a clock, which is the one thing a
 * deterministic fake may not have.
 */
export interface SesTenant {
  name: string;
  id: string;
  /** Also the reputation-entity reference (`ReputationEntityType: RESOURCE`). */
  arn: string;
  sendingStatus: SesSendingStatus;
}

export interface SesCreateTenantInput {
  /** `env-<environmentId>` (DECISIONS §3.2) — stable, opaque, no
   * customer-controlled string in an AWS resource name. */
  tenantName: string;
  tags?: Record<string, string>;
}

export interface SesTenantRef {
  tenantName: string;
}

export interface SesResourceAssociationInput {
  tenantName: string;
  /** An identity, configuration set or template ARN. */
  resourceArn: string;
}

/**
 * A TENANT operation (`PutTenantSuppressionAttributes`), despite the noun.
 *
 * There is a similarly-named configuration-set call
 * (`PutConfigurationSetSuppressionOptions`) that takes no tenant and CANNOT put
 * a tenant onto its own suppression list. Reaching for that one leaves every
 * tenant on the ACCOUNT list, so one customer's hard bounce suppresses that
 * address for all of them — silently, with no error to notice. This is the
 * cross-tenant leak DECISIONS §3 exists to prevent, so the argument is a tenant
 * name and there is deliberately no configuration-set variant on this seam.
 */
export interface SesPutSuppressionScopeInput {
  tenantName: string;
  scope: SesSuppressionScope;
  reasons?: SesSuppressionReason[];
}

// ---------------------------------------------------------------------------
// Configuration set
// ---------------------------------------------------------------------------

/**
 * Deliberately NO suppression options.
 *
 * `CreateConfigurationSet` accepts a `SuppressionOptions` block, and taking it
 * here would offer a second, WRONG place to configure suppression: that block
 * selects which list a send reads, not whether the tenant has a list of its
 * own. Tenant suppression is `putSuppressionScope`, and there is exactly one
 * way to reach it.
 */
export interface SesCreateConfigurationSetInput {
  configurationSetName: string;
  tags?: Record<string, string>;
}

export interface SesConfigurationSetRef {
  configurationSetName: string;
}

/** The SES event types a configuration set can publish. */
export type SesEventType =
  | "SEND"
  | "REJECT"
  | "BOUNCE"
  | "COMPLAINT"
  | "DELIVERY"
  | "OPEN"
  | "CLICK"
  | "RENDERING_FAILURE"
  | "DELIVERY_DELAY"
  | "SUBSCRIPTION";

/**
 * SNS only, by design. PRD 05 consumes SES notifications through SNS, and a
 * union of every destination AWS offers would be five untested branches. A
 * second destination type is an additive change to this one interface.
 */
export interface SesPutEventDestinationInput {
  configurationSetName: string;
  eventDestinationName: string;
  snsTopicArn: string;
  eventTypes: SesEventType[];
  /** Default `true`. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type SesVerificationStatus =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "TEMPORARY_FAILURE"
  | "NOT_STARTED";

export type SesDkimStatus = SesVerificationStatus;

export type SesMailFromStatus =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "TEMPORARY_FAILURE";

/** `USE_DEFAULT_VALUE` keeps sending through amazonses.com when the branded
 * MAIL FROM's MX is missing; `REJECT_MESSAGE` drops the send. */
export type SesMxFailureBehavior = "USE_DEFAULT_VALUE" | "REJECT_MESSAGE";

/** `EXTERNAL` = BYODKIM (our own key, ONE TXT record). `AWS_SES` = Easy DKIM
 * (three CNAMEs) — kept reachable, never the default. */
export type SesDkimOrigin = "EXTERNAL" | "AWS_SES";

export interface SesCreateIdentityInput {
  domain: string;
  configurationSetName?: string;
  /**
   * BYODKIM. Supplying it verifies the domain with ONE TXT record instead of
   * Easy DKIM's three CNAMEs (DECISIONS §2), and lets us sign with a 2048-bit
   * key rather than the 1024 Resend uses.
   */
  dkim?: { selector: string; privateKey: string };
  tags?: Record<string, string>;
}

export interface SesIdentityDkim {
  status: SesDkimStatus;
  signingEnabled: boolean;
  origin: SesDkimOrigin;
  /**
   * `DkimAttributes.Tokens`, and it means TWO different things depending on
   * `origin` — read it with that, never on its own:
   *
   *  - `AWS_SES` (Easy DKIM): the CNAME tokens the customer must publish, one
   *    record each.
   *  - `EXTERNAL` (BYODKIM): the SELECTOR we supplied, echoed back — "this
   *    object contains the selector for the public key" (SESv2 API Reference,
   *    `DkimAttributes`). NO record is implied, so the ONE TXT record claim in
   *    DECISIONS §2 is intact. Live AWS returned `["hogsend"]` on 2026-08-11
   *    where this repo assumed `[]`.
   */
  tokens: string[];
}

export interface SesIdentityMailFrom {
  domain: string;
  status: SesMailFromStatus;
  behaviorOnMxFailure: SesMxFailureBehavior;
}

export interface SesIdentity {
  identity: string;
  /** The ONE thing a caller can act on: this domain can send now. */
  verifiedForSending: boolean;
  verificationStatus: SesVerificationStatus;
  dkim: SesIdentityDkim;
  mailFrom?: SesIdentityMailFrom;
  configurationSetName?: string;
}

export interface SesIdentityRef {
  identity: string;
}

export interface SesSetMailFromInput {
  identity: string;
  /**
   * Must be a subdomain of the identity's own parent domain (DECISIONS §2):
   * customer bounces CANNOT be routed through a Hogsend-owned domain, so the
   * branded return path is always `send.<customer-domain>`.
   */
  mailFromDomain: string;
  /** Default `USE_DEFAULT_VALUE`. */
  behaviorOnMxFailure?: SesMxFailureBehavior;
}

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

/**
 * The auto-pause policy AWS applies to ONE tenant. `STANDARD` pauses on the
 * account's own thresholds, `STRICT` on tighter ones, `NONE` never
 * auto-pauses.
 */
export type SesReputationPolicy = "STANDARD" | "STRICT" | "NONE";

export interface SesSetReputationPolicyInput {
  tenantName: string;
  policy: SesReputationPolicy;
}

export interface SesSetTenantSendingStatusInput {
  tenantName: string;
  status: SesSendingStatus;
}

/**
 * Addressed by NAME, like every other reputation verb, so PRD 08 never has to
 * carry ARNs around. AWS itself addresses a reputation entity by ARN, so the
 * client resolves one — which is why `getTenant` is a first-class verb.
 */
export interface SesReputationEntityRef {
  tenantName: string;
  /**
   * The tenant's ARN, when the caller already has it. Purely an optimisation:
   * PRD 06 persists the ARN at provision time and PRD 08 sweeps every tenant,
   * so paying a second rate-limited call per tenant to re-learn something we
   * already stored would double the sweep for nothing.
   */
  tenantArn?: string;
}

export interface SesReputationStatusRecord {
  status: SesSendingStatus;
  /** Why AWS (or an operator) set it. Free-form. */
  cause?: string;
  /** ISO-8601, when the source reports one. */
  lastUpdatedAt?: string;
}

/**
 * The reconciliation read (PRD 08).
 *
 * SES publishes tenant status changes to EventBridge, and an event can be
 * missed — a delivery failure, a redeploy mid-flight, a subscription that was
 * not there yet. A missed PAUSE leaves the control plane's own mirror saying
 * "active", and the relay reads that mirror, so the failure mode of having no
 * read-back is fail-OPEN: we keep sending for a tenant AWS has stopped. This
 * verb is how the mirror is repaired.
 */
export interface SesReputationEntity {
  /** The entity's ARN — a tenant ARN in this stack. */
  reference: string;
  /**
   * The EFFECTIVE status, aggregated by AWS across both status records. This
   * is the one field a reconciler mirrors; the two records below say WHO
   * decided it.
   */
  sendingStatus?: SesSendingStatus;
  /** The policy, mapped back from its ARN into our own vocabulary. */
  policy?: SesReputationPolicy;
  /** The raw ARN, kept whether or not it parsed — never discard AWS's answer. */
  policyArn?: string;
  /** Set by us, through `setTenantSendingStatus`. */
  customerManagedStatus?: SesReputationStatusRecord;
  /** Set by AWS's own reputation policy. An operator cannot argue with it. */
  awsSesManagedStatus?: SesReputationStatusRecord;
  /** How much reputation trouble this entity is in. `NONE` on a healthy one. */
  impact?: SesReputationImpact;
}

/**
 * An ENTITY's reputation impact, which is NOT the recommendation enum.
 *
 * AWS returned `NONE` on a freshly created tenant on 2026-08-11, and the SDK's
 * own `RecommendationImpact` (`HIGH | LOW`) cannot express it — SDK enums are
 * open, so the wire value arrives regardless and only the TYPE would have been
 * wrong. Widened here rather than in `SesRecommendationImpact`, because
 * `listRecommendations` really does answer only the two.
 */
export type SesReputationImpact = SesRecommendationImpact | "NONE";

export type SesRecommendationType =
  | "BIMI"
  | "BOUNCE"
  | "COMPLAINT"
  | "DKIM"
  | "DMARC"
  | "FEEDBACK_3P"
  | "IP_LISTING"
  | "SPF";

export type SesRecommendationImpact = "HIGH" | "LOW";

export type SesRecommendationStatus = "OPEN" | "FIXED";

export interface SesRecommendation {
  resourceArn?: string;
  type?: SesRecommendationType;
  status?: SesRecommendationStatus;
  impact?: SesRecommendationImpact;
  description?: string;
  /** ISO-8601. A string, not a `Date`, so it survives a jsonb round trip. */
  createdAt?: string;
  lastUpdatedAt?: string;
}

export interface SesListRecommendationsInput {
  resourceArn?: string;
  status?: SesRecommendationStatus;
  impact?: SesRecommendationImpact;
  type?: SesRecommendationType;
  pageSize?: number;
  nextToken?: string;
}

export interface SesRecommendationsPage {
  recommendations: SesRecommendation[];
  nextToken?: string;
}
