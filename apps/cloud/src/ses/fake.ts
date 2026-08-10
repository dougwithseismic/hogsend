import type { SubstrateRegion } from "../substrate/types";
import { resolveSesRegion, type SesClient } from "./contract";
import {
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
  private messageCounter = 0;

  constructor(options: FakeSesClientOptions) {
    // Same guard as the AWS client, and for the same reason: a fake that
    // accepted `ap-south-1` would let a caller pass its tests and then fail at
    // the first live provision.
    this.awsRegion = resolveSesRegion(options.region);
    this.region = options.region;
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
    this.record("sendBatch", [input]);

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
        const error =
          thrown instanceof SesError
            ? thrown
            : new SesError(String(thrown), { kind: "unknown" });
        results.push({
          status: "failed",
          kind: error.kind,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        });
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
    tenant.suppressionScope = input.scope;
    if (input.reasons) tenant.suppressedReasons = [...input.reasons];
  }

  async deleteTenant(input: SesTenantRef): Promise<void> {
    this.record("deleteTenant", [input]);
    this.mustGetTenant(input.tenantName);
    this.tenants.delete(input.tenantName);
  }

  async associateResource(input: SesResourceAssociationInput): Promise<void> {
    this.record("associateResource", [input]);
    const tenant = this.mustGetTenant(input.tenantName);
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
      verificationStatus: "PENDING",
      dkim: {
        status: "PENDING",
        signingEnabled: true,
        origin: input.dkim ? "EXTERNAL" : "AWS_SES",
        // Easy DKIM issues three CNAME tokens; BYODKIM issues none, because the
        // key is ours and one TXT record carries the public half.
        tokens: input.dkim
          ? []
          : ["fake-token-1", "fake-token-2", "fake-token-3"],
      },
      ...(input.configurationSetName
        ? { configurationSetName: input.configurationSetName }
        : {}),
    };
    this.identities.set(identity.identity, identity);
    return cloneIdentity(identity);
  }

  async getIdentity(input: SesIdentityRef): Promise<SesIdentity> {
    this.record("getIdentity", [input]);
    return cloneIdentity(this.mustGetIdentity(input.identity));
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
    this.mustGetTenant(input.tenantName).sendingStatus = input.status;
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
      customerManagedStatus: { status: tenant.sendingStatus },
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
