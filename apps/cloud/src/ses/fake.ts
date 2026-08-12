import type { SubstrateRegion } from "../substrate/types";
import { reputationPolicyArn } from "./aws";
import { resolveSesRegion, type SesClient } from "./contract";
import {
  type SesAccount,
  type SesBatchEntryResult,
  type SesConfigurationSetRef,
  type SesCreateConfigurationSetInput,
  type SesCreateIdentityInput,
  type SesCreateTenantInput,
  SesError,
  type SesEventType,
  type SesIdentity,
  type SesIdentityRef,
  type SesListRecommendationsInput,
  type SesMessage,
  type SesPutEventDestinationInput,
  type SesPutSuppressionScopeInput,
  type SesRecommendation,
  type SesRecommendationsPage,
  type SesRegion,
  type SesReputationEntity,
  type SesReputationEntityRef,
  type SesReputationPolicy,
  type SesResourceAssociationInput,
  type SesSendBatchInput,
  type SesSendBatchResult,
  type SesSendEmailInput,
  type SesSendEmailResult,
  type SesSendingStatus,
  type SesSetMailFromInput,
  type SesSetReputationPolicyInput,
  type SesSetTenantSendingStatusInput,
  type SesSuppressionReason,
  type SesSuppressionScope,
  type SesTenant,
  type SesTenantRef,
} from "./types";

/**
 * The in-memory SES client: every control-plane test and all of local dev.
 *
 * DETERMINISTIC by construction — no `Date.now()`, no randomness, no timers.
 * The one timestamp AWS makes it report comes off an injectable clock that
 * defaults to a FIXED instant (`FAKE_SES_CLOCK`), never wall-clock.
 * Tenant ids and ARNs are DERIVED from the tenant name, so two instances driven
 * with the same inputs produce byte-identical output and a test that asserts an
 * id is asserting a fact rather than recording a sample. Message ids count up
 * from a per-instance counter, because a message id genuinely has to be unique
 * per send and nothing else about it is observable.
 *
 * It is STATEFUL, and that matters more than its brevity: PRDs 03 and 05–09 all
 * test against it, and they need to drive real transitions — an identity that
 * is unverified until something verifies it, a tenant that refuses to send
 * while it is paused — rather than stub a return value. A fake that answered
 * "verified" at creation would let PRD 07 ship a domain flow that never waits,
 * which is precisely the class of bug that shipped from the substrate seam
 * before its fake was made to withhold certificates.
 *
 * The send path enforces the wire's own sender-side preconditions, from
 * `SendEmail`'s documented contract: the from address must resolve to a
 * VERIFIED identity, and — because the send names a tenant — that identity
 * must be ASSOCIATED with the tenant ("the email sending operation will only
 * succeed if all referenced resources ... are associated with this tenant").
 * A fake that delivered anyway would certify the two production-only failures
 * this seam exists to catch: send-before-verify, and a provision that forgot
 * `associateResource`. The association itself carries the matching rule from
 * the other side — `associateResource` answers `not_found` for a resource that
 * does not exist, as AWS does — so a provision cannot satisfy the send-path
 * check by associating a resource it never created. Attachments ride the
 * recorded message VERBATIM —
 * `__sent()` is where a test reads back exactly what crossed the seam, files
 * included. Deliberately NOT modelled on the send path, so nobody assumes
 * coverage: configuration-set existence, association, and SES's attachment
 * file-extension policy — AWS documents that it "restricts certain file
 * extensions" but not whether a blocked one is refused synchronously at
 * `SendEmail` or accepted and rejected later (its `MessageId` note says a
 * message CAN be accepted without being sent); PRD 18's `email.rejected` owns
 * the async reject path either way, so the Fake accepts every file rather
 * than inventing a synchronous refusal we have never observed.
 *
 * Affordances, mirroring `FakeSubstrate` and `FakeBilling`:
 *  - `failNext(method, error?)` scripts the NEXT call to that method to throw.
 *    Default is a RETRYABLE `transient`, the interesting case for a caller's
 *    backoff; pass an explicit error for the permanent one;
 *  - `calls` records `{ method, args }` in order, INCLUDING calls that threw;
 *  - `reset()` drops all state and every counter.
 *
 * Everything prefixed `__` is test-only: a state poke (`__pauseTenant`) or a
 * read of internal state (`__sent`). Production code must never call one, and
 * the prefix is there so a review can see that at a glance.
 */

export const FAKE_SES_ID = "fake";

/** Obviously-not-real account id, so a leak into a live path is visible. */
const FAKE_ACCOUNT_ID = "000000000000";

/**
 * The instant every timestamp the Fake stamps carries, unless a caller injects
 * a clock.
 *
 * A CONSTANT rather than `new Date()`, and that is load-bearing: 1473 tests
 * read this Fake, and a wall-clock field is a value no test can assert and
 * every snapshot has to strip. A test that genuinely needs two writes to be
 * distinguishable passes its own `now`.
 */
export const FAKE_SES_CLOCK = "2026-01-01T00:00:00.000Z";

/**
 * AWS's own `Cause` on the customer-managed status record, verbatim from the
 * live run of 2026-08-11: a `PutTenantSendingStatus` write comes back as
 * "Status manually updated." The Fake omitted the field entirely, so PRD 08's
 * enforcement tests were reading a record shape that does not exist.
 */
const CUSTOMER_STATUS_CAUSE = "Status manually updated.";

/**
 * The reputation impact AWS reports for a healthy entity — observed on a
 * freshly created tenant, both before and after a customer write, where the
 * Fake reported nothing at all. The Fake models only this value: an entity
 * AWS has actually impacted is a state no test here can reach, and inventing
 * a poke for it would be modelling a transition we have never seen.
 */
const FAKE_REPUTATION_IMPACT = "NONE" as const;

/**
 * The sandbox quota, verbatim from `aws sesv2 get-account` on 2026-08-11:
 * 200 messages a day, 1 a second, to self-verified addresses only.
 */
const FAKE_SANDBOX_SEND_QUOTA = {
  max24HourSend: 200,
  maxSendRate: 1,
} as const;

/**
 * What the quota becomes once production access is granted — the OPENING
 * quota requested in `docs/ses-production-access-request.md`, which is the
 * only figure we have. Nothing branches on it (the gate reads
 * `productionAccessEnabled` and `sendingEnabled`); it is here so a test that
 * prints an account does not read a sandbox cap on a production account.
 */
const PRODUCTION_SEND_QUOTA = {
  max24HourSend: 50_000,
  maxSendRate: 14,
} as const;

export type FakeSesMethod = Exclude<
  keyof SesClient,
  "id" | "region" | "awsRegion"
>;

export interface FakeSesCall {
  method: FakeSesMethod;
  args: unknown[];
}

export interface FakeSesTenantState {
  name: string;
  id: string;
  arn: string;
  /** What WE set, through `setTenantSendingStatus`. */
  sendingStatus: SesSendingStatus;
  /**
   * Whether `setTenantSendingStatus` has EVER written. AWS omits the
   * customer-managed status record until a customer write exists, and a
   * reconciler asking "has an operator touched this entity?" branches on that
   * presence — so the fake must not fabricate one.
   */
  customerStatusSet?: boolean;
  /** When that write happened, off the injected clock. AWS stamps one. */
  customerStatusUpdatedAt?: string;
  /**
   * What AWS's own reputation policy set, through `__pauseTenant`. Modelled
   * separately because the two answer different questions — "did an operator
   * stop this tenant" versus "did AWS" — and PRD 08 has to tell them apart:
   * only one of them is ours to reverse.
   */
  awsManagedStatus?: { status: SesSendingStatus; cause?: string };
  reputationPolicy: SesReputationPolicy;
  resources: string[];
  suppressionScope?: SesSuppressionScope;
  suppressedReasons?: SesSuppressionReason[];
}

export interface FakeSesEventDestination {
  name: string;
  snsTopicArn: string;
  eventTypes: SesEventType[];
  enabled: boolean;
}

export interface FakeSesConfigurationSetState {
  name: string;
  eventDestinations: FakeSesEventDestination[];
}

export interface FakeSesSentMessage {
  tenantName: string;
  configurationSetName?: string;
  messageId: string;
  message: SesMessage;
}

export interface FakeSesClientOptions {
  region: SubstrateRegion;
  /**
   * The clock AWS's own timestamps are stamped from. Defaults to a FIXED
   * instant (`FAKE_SES_CLOCK`), never wall-clock — determinism is this Fake's
   * first property. Inject one only to tell two writes apart.
   */
  now?: () => Date;
}

export class FakeSesClient implements SesClient {
  readonly id = FAKE_SES_ID;
  readonly region: SubstrateRegion;
  readonly awsRegion: SesRegion;

  /** Every call made, in order. Cleared with `reset()`. */
  readonly calls: FakeSesCall[] = [];

  private readonly tenants = new Map<string, FakeSesTenantState>();
  private readonly identities = new Map<string, SesIdentity>();
  private readonly configurationSets = new Map<
    string,
    FakeSesConfigurationSetState
  >();
  private readonly sent: FakeSesSentMessage[] = [];
  private readonly recommendations: SesRecommendation[] = [];
  private readonly rejectedRecipients = new Set<string>();
  private readonly scriptedFailures = new Map<FakeSesMethod, SesError[]>();
  private accountPaused = false;
  /** SANDBOX by default — the real account's state. See `getAccount`. */
  private productionAccess = false;
  private messageCounter = 0;
  private readonly now: () => Date;

  constructor(options: FakeSesClientOptions) {
    // Same guard as the AWS client, and for the same reason: a fake that
    // accepted `ap-south-1` would let a caller pass its tests and then fail at
    // the first live provision.
    this.awsRegion = resolveSesRegion(options.region);
    this.region = options.region;
    this.now = options.now ?? (() => new Date(FAKE_SES_CLOCK));
  }

  // -- Test affordances -----------------------------------------------------

  failNext(method: FakeSesMethod, error?: SesError): this {
    const queue = this.scriptedFailures.get(method) ?? [];
    queue.push(
      error ??
        new SesError(`fake SES: scripted failure in ${method}`, {
          kind: "transient",
          operation: method,
        }),
    );
    this.scriptedFailures.set(method, queue);
    return this;
  }

  reset(): this {
    this.tenants.clear();
    this.identities.clear();
    this.configurationSets.clear();
    this.scriptedFailures.clear();
    this.rejectedRecipients.clear();
    this.sent.length = 0;
    this.recommendations.length = 0;
    this.calls.length = 0;
    this.accountPaused = false;
    this.productionAccess = false;
    this.messageCounter = 0;
    return this;
  }

  /** Advance an identity to verified — the DNS the tenant would publish. */
  __verifyIdentity(identity: string): this {
    const state = this.mustGetIdentity(identity);
    state.verificationStatus = "SUCCESS";
    state.verifiedForSending = true;
    state.dkim.status = "SUCCESS";
    return this;
  }

  /** The other terminal outcome: AWS gave up on the domain. */
  __failIdentity(identity: string): this {
    const state = this.mustGetIdentity(identity);
    state.verificationStatus = "FAILED";
    state.verifiedForSending = false;
    state.dkim.status = "FAILED";
    return this;
  }

  /** The branded return path's MX/SPF landed. */
  __verifyMailFrom(identity: string): this {
    const state = this.mustGetIdentity(identity);
    if (state.mailFrom) state.mailFrom.status = "SUCCESS";
    return this;
  }

  /**
   * Pause ONE tenant the way AWS does it — an automatic reputation-policy
   * decision, not an operator's. That is the case PRD 08 has to reconcile,
   * because it can arrive as an EventBridge event the control plane never saw.
   */
  __pauseTenant(tenantName: string, cause?: string): this {
    this.mustGetTenant(tenantName).awsManagedStatus = {
      status: "DISABLED",
      ...(cause === undefined ? {} : { cause }),
    };
    return this;
  }

  /** Clear the AWS-managed pause. Leaves our own status alone — an operator
   * pause is reversed with `setTenantSendingStatus`, which is a real verb. */
  __resumeTenant(tenantName: string): this {
    this.mustGetTenant(tenantName).awsManagedStatus = undefined;
    return this;
  }

  /** Pause the whole ACCOUNT — every tenant is down (DECISIONS §2's caveat). */
  __pauseAccount(paused = true): this {
    this.accountPaused = paused;
    return this;
  }

  /**
   * Take the account OUT of the sandbox, the way an AWS support decision
   * does. A poke rather than a verb because SES has no API for it: production
   * access is granted by a human at AWS.
   */
  __grantProductionAccess(granted = true): this {
    this.productionAccess = granted;
    return this;
  }

  /** Make one address fail at send time, e.g. an unroutable recipient. */
  __rejectRecipient(email: string): this {
    this.rejectedRecipients.add(email.toLowerCase());
    return this;
  }

  __addRecommendation(recommendation: SesRecommendation): this {
    this.recommendations.push({ ...recommendation });
    return this;
  }

  __tenants(): FakeSesTenantState[] {
    return [...this.tenants.values()].map((tenant) => ({
      ...tenant,
      resources: [...tenant.resources],
    }));
  }

  __tenant(tenantName: string): FakeSesTenantState | undefined {
    const tenant = this.tenants.get(tenantName);
    return tenant ? { ...tenant, resources: [...tenant.resources] } : undefined;
  }

  __configurationSet(
    configurationSetName: string,
  ): FakeSesConfigurationSetState | undefined {
    const set = this.configurationSets.get(configurationSetName);
    return set
      ? {
          ...set,
          eventDestinations: set.eventDestinations.map((destination) => ({
            ...destination,
            eventTypes: [...destination.eventTypes],
          })),
        }
      : undefined;
  }

  __sent(): FakeSesSentMessage[] {
    return this.sent.map((entry) => ({ ...entry, message: entry.message }));
  }

  // -- Send -----------------------------------------------------------------

  async sendEmail(input: SesSendEmailInput): Promise<SesSendEmailResult> {
    this.record("sendEmail", [input]);
    return { messageId: this.deliver(input.tenantName, input) };
  }

  async sendBatch(input: SesSendBatchInput): Promise<SesSendBatchResult> {
    try {
      this.record("sendBatch", [input]);
    } catch (thrown) {
      // The AWS implementation fans out one SendEmail per message and catches
      // per ENTRY, so its sendBatch can NEVER throw wholesale. A scripted
      // batch failure therefore lands on every entry — the shape a wire
      // outage actually produces — rather than as a throw no caller of the
      // real client would ever see.
      const failed = toFailedEntry(toSesError(thrown));
      return { results: input.messages.map(() => ({ ...failed })) };
    }

    const results: SesBatchEntryResult[] = [];
    for (const message of input.messages) {
      try {
        const messageId = this.deliver(input.tenantName, {
          tenantName: input.tenantName,
          configurationSetName: input.configurationSetName,
          message,
        });
        results.push({ status: "sent", messageId });
      } catch (thrown) {
        // Per ENTRY, never all-or-nothing: one bad address must not cost the
        // rest of the batch its delivery.
        results.push(toFailedEntry(toSesError(thrown)));
      }
    }
    return { results };
  }

  // -- Tenant ---------------------------------------------------------------

  async createTenant(input: SesCreateTenantInput): Promise<SesTenant> {
    this.record("createTenant", [input]);

    const existing = this.tenants.get(input.tenantName);
    // Idempotent by name: a re-driven provisioning step must resume, not fail
    // on its own previous success.
    if (existing) return toTenant(existing);

    const state: FakeSesTenantState = {
      name: input.tenantName,
      id: `fake-tenant-${input.tenantName}`,
      arn: `arn:aws:ses:${this.awsRegion}:${FAKE_ACCOUNT_ID}:tenant/${input.tenantName}`,
      sendingStatus: "ENABLED",
      reputationPolicy: "STANDARD",
      resources: [],
    };
    this.tenants.set(state.name, state);
    return toTenant(state);
  }

  async getTenant(input: SesTenantRef): Promise<SesTenant> {
    this.record("getTenant", [input]);
    return toTenant(this.mustGetTenant(input.tenantName));
  }

  async putSuppressionScope(input: SesPutSuppressionScopeInput): Promise<void> {
    this.record("putSuppressionScope", [input]);
    const tenant = this.mustGetTenant(input.tenantName);
    // A PUT, matching the AWS operation: an omitted field is a RESET, not a
    // keep. A fake that merged here would let a re-drive that drops `reasons`
    // pass in tests and clear them in production.
    tenant.suppressionScope = input.scope;
    if (input.reasons) tenant.suppressedReasons = [...input.reasons];
    else delete tenant.suppressedReasons;
  }

  async deleteTenant(input: SesTenantRef): Promise<void> {
    this.record("deleteTenant", [input]);
    this.mustGetTenant(input.tenantName);
    this.tenants.delete(input.tenantName);
  }

  async associateResource(input: SesResourceAssociationInput): Promise<void> {
    this.record("associateResource", [input]);
    const tenant = this.mustGetTenant(input.tenantName);
    // An association names a resource, and the resource has to BE there. AWS
    // answered `NotFoundException` — "Identity <hogsend.com> does not exist" —
    // on the live run of 2026-08-11 where the Fake answered `ok`, so an
    // association naming a typo'd, deleted or not-yet-created resource was
    // green in every test here and 404s in production. The send that follows
    // it then 403s, which is the failure this seam exists to catch.
    this.mustGetAssociableResource(input.resourceArn);
    // Set membership: re-asserting an association is a no-op, not a conflict.
    if (!tenant.resources.includes(input.resourceArn)) {
      tenant.resources.push(input.resourceArn);
    }
  }

  async disassociateResource(
    input: SesResourceAssociationInput,
  ): Promise<void> {
    this.record("disassociateResource", [input]);
    const tenant = this.mustGetTenant(input.tenantName);
    const index = tenant.resources.indexOf(input.resourceArn);
    if (index < 0) {
      throw notFound("Tenant resource association", input.resourceArn);
    }
    tenant.resources.splice(index, 1);
  }

  // -- Configuration set ----------------------------------------------------

  async createConfigurationSet(
    input: SesCreateConfigurationSetInput,
  ): Promise<void> {
    this.record("createConfigurationSet", [input]);
    if (this.configurationSets.has(input.configurationSetName)) {
      throw alreadyExists("Configuration set", input.configurationSetName);
    }
    this.configurationSets.set(input.configurationSetName, {
      name: input.configurationSetName,
      eventDestinations: [],
    });
  }

  async deleteConfigurationSet(input: SesConfigurationSetRef): Promise<void> {
    this.record("deleteConfigurationSet", [input]);
    this.mustGetConfigurationSet(input.configurationSetName);
    this.configurationSets.delete(input.configurationSetName);
  }

  async putEventDestination(input: SesPutEventDestinationInput): Promise<void> {
    this.record("putEventDestination", [input]);
    const set = this.mustGetConfigurationSet(input.configurationSetName);
    const destination: FakeSesEventDestination = {
      name: input.eventDestinationName,
      snsTopicArn: input.snsTopicArn,
      eventTypes: [...input.eventTypes],
      enabled: input.enabled ?? true,
    };
    const index = set.eventDestinations.findIndex(
      (existing) => existing.name === input.eventDestinationName,
    );
    // A verb called `put` is a PUT: PRD 05 re-runs it on every resume.
    if (index < 0) set.eventDestinations.push(destination);
    else set.eventDestinations[index] = destination;
  }

  // -- Identity -------------------------------------------------------------

  async createIdentity(input: SesCreateIdentityInput): Promise<SesIdentity> {
    this.record("createIdentity", [input]);
    if (this.identities.has(input.domain)) {
      throw alreadyExists("Email identity", input.domain);
    }
    const identity: SesIdentity = {
      identity: input.domain,
      // NEVER verified on creation: the tenant has not published DNS yet, and
      // claiming otherwise would let PRD 07's wait be skipped entirely.
      verifiedForSending: false,
      // `NOT_STARTED`, which is what AWS returned on the first live run
      // (2026-08-11) where the Fake said `PENDING`. The SESv2 API Reference
      // documents it as "The DKIM verification process hasn't been initiated
      // for the domain" — precisely a domain whose DNS is not out yet.
      verificationStatus: "NOT_STARTED",
      dkim: {
        status: "NOT_STARTED",
        signingEnabled: true,
        origin: input.dkim ? "EXTERNAL" : "AWS_SES",
        // Easy DKIM issues three CNAME tokens the customer must publish.
        // BYODKIM issues no CNAME at all: what comes back is the SELECTOR we
        // supplied, echoed. "If you configured DKIM authentication for the
        // domain by providing your own public-private key pair, then this
        // object contains the selector for the public key" (SESv2 API
        // Reference, `DkimAttributes` → `Tokens`). So a non-empty `tokens`
        // here implies NO second DNS record, and the ONE TXT record claim
        // stands. The Fake returned `[]` until 2026-08-11, which taught every
        // reader that a token list means Easy DKIM.
        tokens: input.dkim
          ? [input.dkim.selector]
          : ["fake-token-1", "fake-token-2", "fake-token-3"],
      },
      ...(input.configurationSetName
        ? { configurationSetName: input.configurationSetName }
        : {}),
    };
    this.identities.set(identity.identity, identity);
    return cloneIdentity(identity);
  }

  /**
   * Reading an identity STARTS its verification, because that is what AWS does.
   *
   * The status is not static, and the live run of 2026-08-11 is the only reason
   * we know: `createIdentity` answered `NOT_STARTED`, and `getIdentity` on the
   * very next call answered `PENDING`. SES kicks off the DNS lookup
   * asynchronously right after the identity exists, so by the time anything
   * reads it back the process has begun.
   *
   * It matters because every caller that polls a domain reads through here.
   * A Fake pinned at `NOT_STARTED` would teach those tests that the state a
   * poller sees is the state creation returned, and it never is — the real
   * sequence is NOT_STARTED once, then PENDING until SUCCESS or FAILED.
   *
   * The promotion is PERSISTED rather than computed per call, so it happens
   * exactly once and the Fake stays deterministic: same call sequence in, same
   * answers out, with no clock involved.
   */
  async getIdentity(input: SesIdentityRef): Promise<SesIdentity> {
    this.record("getIdentity", [input]);
    const identity = this.mustGetIdentity(input.identity);
    if (identity.verificationStatus === "NOT_STARTED") {
      identity.verificationStatus = "PENDING";
    }
    if (identity.dkim.status === "NOT_STARTED") {
      identity.dkim.status = "PENDING";
    }
    return cloneIdentity(identity);
  }

  async setMailFrom(input: SesSetMailFromInput): Promise<void> {
    this.record("setMailFrom", [input]);
    const identity = this.mustGetIdentity(input.identity);
    identity.mailFrom = {
      domain: input.mailFromDomain,
      // Pending until the MX and SPF records resolve — same reasoning as the
      // identity itself.
      status: "PENDING",
      behaviorOnMxFailure: input.behaviorOnMxFailure ?? "USE_DEFAULT_VALUE",
    };
  }

  async deleteIdentity(input: SesIdentityRef): Promise<void> {
    this.record("deleteIdentity", [input]);
    this.mustGetIdentity(input.identity);
    this.identities.delete(input.identity);
  }

  // -- Reputation -----------------------------------------------------------

  async setReputationPolicy(input: SesSetReputationPolicyInput): Promise<void> {
    this.record("setReputationPolicy", [input]);
    this.mustGetTenant(input.tenantName).reputationPolicy = input.policy;
  }

  async setTenantSendingStatus(
    input: SesSetTenantSendingStatusInput,
  ): Promise<void> {
    this.record("setTenantSendingStatus", [input]);
    const tenant = this.mustGetTenant(input.tenantName);
    tenant.sendingStatus = input.status;
    tenant.customerStatusSet = true;
    tenant.customerStatusUpdatedAt = this.now().toISOString();
  }

  async getReputationEntity(
    input: SesReputationEntityRef,
  ): Promise<SesReputationEntity> {
    this.record("getReputationEntity", [input]);
    // Keyed by NAME, like every other reputation verb. `tenantArn` is only an
    // optimisation on the AWS client (it skips an ARN lookup), so the Fake
    // accepts it and ignores it — a test that passes one must get the same
    // answer as a test that does not.
    const tenant = this.tenants.get(input.tenantName);
    if (!tenant) throw notFound("Reputation entity", input.tenantName);

    return {
      reference: tenant.arn,
      sendingStatus: effectiveSendingStatus(tenant),
      policy: tenant.reputationPolicy,
      // The SAME fact in AWS's own encoding, and AWS returns BOTH: a policy
      // travels as an AWS-owned ARN, and the live run of 2026-08-11 read one
      // back on an entity nobody had written a status to. Derived from
      // `reputationPolicyArn` rather than spelled again here, so the ARN a
      // test reads is byte-identical to the one `setReputationPolicy` sends.
      policyArn: reputationPolicyArn(this.awsRegion, tenant.reputationPolicy),
      // Present on a healthy entity too, before any customer write — the Fake
      // omitted it entirely, so PRD 08 was taught an entity shape with no
      // impact field at all.
      impact: FAKE_REPUTATION_IMPACT,
      // ABSENT until a customer write exists, exactly like AWS: a reconciler
      // asking "has an operator ever touched this entity?" branches on the
      // record's presence, and a fabricated one would mislead it. Once it
      // exists AWS fills in its own cause and a timestamp, both of which the
      // Fake omitted.
      ...(tenant.customerStatusSet
        ? {
            customerManagedStatus: {
              status: tenant.sendingStatus,
              cause: CUSTOMER_STATUS_CAUSE,
              ...(tenant.customerStatusUpdatedAt === undefined
                ? {}
                : { lastUpdatedAt: tenant.customerStatusUpdatedAt }),
            },
          }
        : {}),
      ...(tenant.awsManagedStatus
        ? { awsSesManagedStatus: { ...tenant.awsManagedStatus } }
        : {}),
    };
  }

  async listRecommendations(
    input: SesListRecommendationsInput = {},
  ): Promise<SesRecommendationsPage> {
    this.record("listRecommendations", [input]);
    const recommendations = this.recommendations.filter(
      (recommendation) =>
        (input.resourceArn === undefined ||
          recommendation.resourceArn === input.resourceArn) &&
        (input.status === undefined ||
          recommendation.status === input.status) &&
        (input.impact === undefined ||
          recommendation.impact === input.impact) &&
        (input.type === undefined || recommendation.type === input.type),
    );
    // No paging: the fake holds whatever a test put in it, and inventing a
    // page boundary would be a behaviour AWS does not guarantee either.
    return { recommendations: recommendations.map((r) => ({ ...r })) };
  }

  // -- Account --------------------------------------------------------------

  /**
   * The account, defaulting to the SANDBOX — because that is what the real
   * account IS, read on 2026-08-11: `ProductionAccessEnabled=false`,
   * `SendingEnabled=true`, 200 a day, 1 a second.
   *
   * The default is the load-bearing part. This Fake decides, in every test,
   * whether a provision may activate Hogsend Email; a Fake that answered
   * "production access" would hand a green test to the exact bug the gate
   * exists to stop, which is PRD 14's lesson stated as a default value.
   * `__grantProductionAccess()` moves it, because AWS moves it — by a support
   * decision, never by an API call, which is why there is no verb for it.
   */
  async getAccount(): Promise<SesAccount> {
    this.record("getAccount", []);
    return {
      productionAccessEnabled: this.productionAccess,
      // The account pause `sendEmail` already refuses on, read from the other
      // side: AWS reports a suspended account as `SendingEnabled: false`.
      sendingEnabled: !this.accountPaused,
      enforcementStatus: this.accountPaused ? "SHUTDOWN" : "HEALTHY",
      ...(this.productionAccess
        ? PRODUCTION_SEND_QUOTA
        : FAKE_SANDBOX_SEND_QUOTA),
    };
  }

  // -- Internals ------------------------------------------------------------

  /**
   * The one place a send is decided. Ordered so the LOUDEST refusal wins: an
   * account suspension is not a tenant's problem to interpret.
   */
  private deliver(tenantName: string, input: SesSendEmailInput): string {
    if (this.accountPaused) {
      throw new SesError(
        "fake SES: the account's ability to send email is suspended",
        { kind: "account_paused", operation: "sendEmail" },
      );
    }
    const tenant = this.mustGetTenant(tenantName);
    if (effectiveSendingStatus(tenant) === "DISABLED") {
      throw new SesError(
        `fake SES: sending is paused for tenant ${tenantName}`,
        { kind: "tenant_paused", operation: "sendEmail" },
      );
    }

    const recipients = input.message.to ?? [];
    if (recipients.length === 0) {
      throw new SesError("fake SES: a message needs at least one recipient", {
        kind: "invalid",
        operation: "sendEmail",
      });
    }

    // The sender-side preconditions the real wire enforces. Verification
    // first: SES answers an unverified from with MessageRejected ("Email
    // address is not verified"), which classifies as `invalid`.
    const fromAddress = fromAddrSpec(input.message.from);
    const atIndex = fromAddress.lastIndexOf("@");
    const domain = atIndex >= 0 ? fromAddress.slice(atIndex + 1) : undefined;
    const identityKey = this.identities.has(fromAddress)
      ? fromAddress
      : domain !== undefined && this.identities.has(domain)
        ? domain
        : undefined;
    const identity =
      identityKey === undefined ? undefined : this.identities.get(identityKey);
    if (!identity?.verifiedForSending) {
      throw new SesError(
        `fake SES: email address is not verified: ${input.message.from}`,
        { kind: "invalid", operation: "sendEmail" },
      );
    }
    // And association: a send that names a tenant only succeeds if the
    // referenced identity is associated with it (`SendEmail`'s documented
    // contract) — the check that catches a provision which forgot
    // `associateResource`, in a test instead of on the first customer send.
    const associated = tenant.resources.some((arn) =>
      arn.toLowerCase().endsWith(`identity/${identityKey}`),
    );
    if (!associated) {
      throw new SesError(
        `fake SES: identity ${identityKey} is not associated with tenant ${tenantName}`,
        { kind: "invalid", operation: "sendEmail" },
      );
    }

    const rejected = recipients.find((address) =>
      this.rejectedRecipients.has(address.toLowerCase()),
    );
    if (rejected) {
      throw new SesError(`fake SES: recipient ${rejected} was rejected`, {
        kind: "invalid",
        operation: "sendEmail",
        detail: `fake SES rejected ${rejected}`,
      });
    }

    this.messageCounter += 1;
    const messageId = `fake-ses-message-${this.messageCounter}`;
    this.sent.push({
      tenantName,
      ...(input.configurationSetName
        ? { configurationSetName: input.configurationSetName }
        : {}),
      messageId,
      message: input.message,
    });
    return messageId;
  }

  /** Log the call, THEN honour a scripted failure — a retry assertion needs
   * the failed attempt in the log, not only the one that worked. */
  private record(method: FakeSesMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.scriptedFailures.get(method)?.shift();
    if (failure) throw failure;
  }

  private mustGetTenant(tenantName: string): FakeSesTenantState {
    const tenant = this.tenants.get(tenantName);
    if (!tenant) throw notFound("Tenant", tenantName);
    return tenant;
  }

  private mustGetIdentity(identity: string): SesIdentity {
    const found = this.identities.get(identity);
    if (!found) throw notFound("Email identity", identity);
    return found;
  }

  /**
   * Prove the resource an association ARN names actually exists.
   *
   * A tenant holds exactly two kinds of resource — an email identity and a
   * configuration set — so the ARN is read for its resource segment and the
   * thing it names is looked up in the state this Fake actually holds. That is
   * the RULE, not a check aimed at the one ARN the live run got wrong: any
   * association of anything absent answers `not_found`, whichever verb built
   * the ARN.
   *
   * An ARN of any OTHER shape is refused rather than waved through. Its
   * existence is not something the Fake can check, and accepting an unverified
   * membership is exactly the hole being closed here. `invalid` rather than
   * `not_found`, because what is wrong is the ARN itself, not a resource that
   * has gone missing.
   */
  private mustGetAssociableResource(resourceArn: string): void {
    const { type, name } = parseResourceArn(resourceArn);
    if (type === "identity") {
      this.mustGetIdentity(name);
      return;
    }
    if (type === "configuration-set") {
      this.mustGetConfigurationSet(name);
      return;
    }
    throw new SesError(
      `fake SES: ${JSON.stringify(
        resourceArn,
      )} does not name a resource a tenant can be associated with (an email identity or a configuration set)`,
      { kind: "invalid", operation: "associateResource" },
    );
  }

  private mustGetConfigurationSet(
    configurationSetName: string,
  ): FakeSesConfigurationSetState {
    const set = this.configurationSets.get(configurationSetName);
    if (!set) throw notFound("Configuration set", configurationSetName);
    return set;
  }
}

function toTenant(state: FakeSesTenantState): SesTenant {
  return {
    name: state.name,
    id: state.id,
    arn: state.arn,
    // The EFFECTIVE status, which is what AWS's `Tenant.SendingStatus` reports:
    // a caller asking "can this tenant send" must not have to know which of the
    // two sources stopped it.
    sendingStatus: effectiveSendingStatus(state),
  };
}

/** Either source can stop a tenant; neither can override the other's stop. */
function effectiveSendingStatus(state: FakeSesTenantState): SesSendingStatus {
  if (state.awsManagedStatus?.status === "DISABLED") return "DISABLED";
  return state.sendingStatus;
}

function cloneIdentity(identity: SesIdentity): SesIdentity {
  return {
    ...identity,
    dkim: { ...identity.dkim, tokens: [...identity.dkim.tokens] },
    ...(identity.mailFrom ? { mailFrom: { ...identity.mailFrom } } : {}),
  };
}

/**
 * The lowercased addr-spec out of an RFC 5322 `from` — `"Acme <a@b.c>"` or
 * bare `a@b.c`. Both forms must resolve to the same identity, because both
 * are legal on the wire.
 */
function fromAddrSpec(from: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(from);
  return (angle?.[1] ?? from).trim().toLowerCase();
}

/**
 * The `<type>/<name>` tail of a resource ARN, or two empty strings when there
 * is no such tail.
 *
 * Split at the SIXTH colon-separated field and then at the FIRST slash: an
 * ARN's first five fields are fixed, and everything after them is the resource,
 * which may itself contain colons. An email identity's name is a domain or an
 * email address — `identity/ses-proof@hogsend.com` is a real one — so the
 * `@` is carried through untouched.
 */
function parseResourceArn(arn: string): { type: string; name: string } {
  const fields = arn.split(":");
  const resource = fields.length > 5 ? fields.slice(5).join(":") : "";
  const slash = resource.indexOf("/");
  return slash < 0
    ? { type: "", name: "" }
    : { type: resource.slice(0, slash), name: resource.slice(slash + 1) };
}

function toSesError(thrown: unknown): SesError {
  return thrown instanceof SesError
    ? thrown
    : new SesError(String(thrown), { kind: "unknown" });
}

function toFailedEntry(error: SesError): SesBatchEntryResult {
  return {
    status: "failed",
    kind: error.kind,
    message: error.message,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

function notFound(resource: string, id: string): SesError {
  return new SesError(`fake SES: ${resource} "${id}" does not exist`, {
    kind: "not_found",
  });
}

function alreadyExists(resource: string, id: string): SesError {
  return new SesError(`fake SES: ${resource} "${id}" already exists`, {
    kind: "already_exists",
  });
}
