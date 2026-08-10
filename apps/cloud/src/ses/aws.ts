import type {
  CreateEmailIdentityResponse,
  CreateTenantResponse,
  GetEmailIdentityResponse,
  GetReputationEntityResponse,
  GetTenantResponse,
  ListRecommendationsResponse,
  SendEmailResponse,
} from "@aws-sdk/client-sesv2";
import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteConfigurationSetCommand,
  DeleteEmailIdentityCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetEmailIdentityCommand,
  GetReputationEntityCommand,
  GetTenantCommand,
  ListRecommendationsCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutTenantSuppressionAttributesCommand,
  SESv2Client,
  SendEmailCommand,
  UpdateConfigurationSetEventDestinationCommand,
  UpdateReputationEntityCustomerManagedStatusCommand,
  UpdateReputationEntityPolicyCommand,
} from "@aws-sdk/client-sesv2";
import type { SubstrateRegion } from "../substrate/types";
import { resolveSesRegion, type SesClient } from "./contract";
import {
  type SesBatchEntryResult,
  type SesConfigurationSetRef,
  type SesCreateConfigurationSetInput,
  type SesCreateIdentityInput,
  type SesCreateTenantInput,
  type SesDkimOrigin,
  type SesDkimStatus,
  SesError,
  type SesErrorKind,
  type SesIdentity,
  type SesIdentityRef,
  type SesListRecommendationsInput,
  type SesMailFromStatus,
  type SesMessage,
  type SesPutEventDestinationInput,
  type SesPutSuppressionScopeInput,
  type SesRecommendation,
  type SesRecommendationImpact,
  type SesRecommendationStatus,
  type SesRecommendationsPage,
  type SesRecommendationType,
  type SesRegion,
  type SesReputationEntity,
  type SesReputationEntityRef,
  type SesReputationPolicy,
  type SesReputationStatusRecord,
  type SesResourceAssociationInput,
  type SesSendBatchInput,
  type SesSendBatchResult,
  type SesSendEmailInput,
  type SesSendEmailResult,
  type SesSendingStatus,
  type SesSetMailFromInput,
  type SesSetReputationPolicyInput,
  type SesSetTenantSendingStatusInput,
  type SesTenant,
  type SesTenantRef,
  type SesVerificationStatus,
} from "./types";

/**
 * The real SES client, over `@aws-sdk/client-sesv2`.
 *
 * v2 only: the v1 `client-ses` API has no tenant support at all, and tenants
 * are the isolation primitive this whole stack is built on.
 *
 * Three things it owns, because nothing above the seam may know them:
 *  - which SDK command implements each of our nineteen contract verbs;
 *  - the retry policy, which NEVER retries a 4xx;
 *  - the translation of every AWS failure into a classified `SesError` that
 *    still carries the response body.
 */

export const AWS_SES_ID = "aws";

/**
 * Attempts INCLUDING the first. Five over the backoff below spans ~3s of
 * sleeping, which covers a throttle burst without making a provisioning step
 * hang for a minute on a genuine outage — the pipeline re-drives the step, so
 * a long in-process retry buys nothing the pipeline does not already do.
 */
export const SES_MAX_ATTEMPTS = 5;

/** First backoff step; each retry doubles it, up to {@link SES_BACKOFF_MAX_MS}. */
export const SES_BACKOFF_BASE_MS = 200;

export const SES_BACKOFF_MAX_MS = 5_000;

/**
 * Concurrent sends inside one `sendBatch`. Small on purpose — see
 * `AwsSesClient.sendBatch` for the quota arithmetic that picks it.
 */
export const SES_BATCH_CONCURRENCY = 4;

/** Response bodies land in logs and on `stacks.last_error`; keep them bounded. */
const MAX_DETAIL_CHARS = 2_000;

/**
 * Deterministic exponential backoff — 200, 400, 800, 1600, 3200, 5000ms
 * (capped). NO jitter, matching the Railway client: one provisioning task runs
 * per stack, so there is no thundering herd to spread, and a fixed sequence is
 * assertable in a test.
 */
export function sesBackoffMs(attempt: number): number {
  return Math.min(SES_BACKOFF_BASE_MS * 2 ** (attempt - 1), SES_BACKOFF_MAX_MS);
}

/**
 * The injectable wire. Structural on purpose — narrower than `SESv2Client`, so
 * a test supplies an in-memory responder without constructing a real client,
 * and no test can reach AWS by forgetting to stub something.
 */
export interface SesCommandLike {
  readonly input: unknown;
}

export type SesTransport = (command: SesCommandLike) => Promise<unknown>;

/** Injectable so tests assert the backoff SEQUENCE without waiting for it. */
export type SleepFn = (ms: number) => Promise<void>;

export interface AwsSesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AwsSesClientOptions {
  /**
   * REQUIRED, and validated against the `SubstrateRegion` mapping. SES tenants
   * are region-scoped and do not replicate, so a client that could silently
   * target the wrong region would mint tenants nobody can find again.
   */
  region: SubstrateRegion;
  /** Absent → the SDK's default credential chain (never used on Railway). */
  credentials?: AwsSesCredentials;
  send?: SesTransport;
  sleep?: SleepFn;
  maxAttempts?: number;
  /** Overrides {@link SES_BATCH_CONCURRENCY} for this client. */
  batchConcurrency?: number;
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AwsSesClient implements SesClient {
  readonly id = AWS_SES_ID;
  readonly region: SubstrateRegion;
  readonly awsRegion: SesRegion;

  private readonly transport: SesTransport;
  private readonly sleep: SleepFn;
  private readonly maxAttempts: number;
  private readonly batchConcurrency: number;

  constructor(options: AwsSesClientOptions) {
    this.awsRegion = resolveSesRegion(options.region);
    this.region = options.region;
    this.transport =
      options.send ?? realTransport(this.awsRegion, options.credentials);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? SES_MAX_ATTEMPTS;
    this.batchConcurrency = options.batchConcurrency ?? SES_BATCH_CONCURRENCY;
  }

  // -- Send -----------------------------------------------------------------

  async sendEmail(input: SesSendEmailInput): Promise<SesSendEmailResult> {
    const response = await this.call<SendEmailResponse>(
      "sendEmail",
      new SendEmailCommand({
        // Without TenantName the send lands on the ACCOUNT, and per-tenant
        // reputation, suppression and pause all quietly stop meaning anything.
        TenantName: input.tenantName,
        ...(input.configurationSetName
          ? { ConfigurationSetName: input.configurationSetName }
          : {}),
        ...toSendEmailFields(input.message),
      }),
    );
    return { messageId: response.MessageId ?? "" };
  }

  /**
   * One `SendEmail` per message, on a bounded pool, answered in INPUT order.
   *
   * NOT `SendBulkEmail`, and that is a constraint rather than a preference.
   * Confirmed against the SESv2 API reference: `SendBulkEmail`'s body is
   * `BulkEmailContent { Template }` — template only — and the per-recipient
   * override is `ReplacementEmailContent { ReplacementTemplate {
   * ReplacementTemplateData } }`, which is template VARIABLES, not a body. The
   * engine's tracked mailer hands this seam fully-rendered per-recipient HTML
   * (React rendered, links rewritten, open pixel injected), so there is no SES
   * template to bulk against, and forcing that HTML through `TemplateData`
   * would break on any customer markup containing `{{`. Therefore
   * `ses:SendBulkEmail` is NOT in the IAM policy: we never call it.
   *
   * ## Why a SMALL pool rather than serial, or unbounded
   *
   * The account's send RATE is the real ceiling, not our loop: the opening
   * quota being requested is 14 messages/second, and one round trip to SES is
   * roughly 50-150ms. A serial loop therefore runs at 7-20/s — at the quota
   * when SES is fast, and HALF of it when SES is slow, which is exactly the
   * latency PRD 03 would inherit on a broadcast. A small pool covers that
   * variance without chasing throughput the account does not have.
   *
   * Unbounded is the other failure: a hundred concurrent connections earns a
   * throttle that costs more than it saves. Between the two, the pool is
   * self-limiting — anything over the quota comes back `throttled`, which is
   * retryable and already backs off, so the batch converges to the account's
   * real rate instead of hammering past it.
   *
   * {@link SES_BATCH_CONCURRENCY} is the knob to raise as the quota ramps (the
   * plan in `docs/ses-production-access-request.md`); `batchConcurrency`
   * overrides it per client.
   *
   * Results are POSITIONAL — `results[i]` answers `messages[i]` whatever order
   * the sends complete in. PRD 03 pairs them by index, so appending on
   * completion would mis-attribute every delivery in the batch.
   */
  async sendBatch(input: SesSendBatchInput): Promise<SesSendBatchResult> {
    const { messages } = input;
    const results = new Array<SesBatchEntryResult>(messages.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        // No lock needed: the read and the increment are one synchronous step,
        // and JS gives us no preemption between them.
        const index = next++;
        const message = messages[index];
        if (message === undefined) return;
        results[index] = await this.sendOne(input, message);
      }
    };

    const workers = Math.min(this.batchConcurrency, messages.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return { results };
  }

  /** One message of a batch. NEVER throws — a batch reports per entry. */
  private async sendOne(
    input: SesSendBatchInput,
    message: SesMessage,
  ): Promise<SesBatchEntryResult> {
    try {
      const sent = await this.sendEmail({
        tenantName: input.tenantName,
        ...(input.configurationSetName
          ? { configurationSetName: input.configurationSetName }
          : {}),
        message,
      });
      return { status: "sent", messageId: sent.messageId };
    } catch (thrown) {
      const error = classifySesError(thrown, "sendBatch");
      return {
        status: "failed",
        kind: error.kind,
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      };
    }
  }

  // -- Tenant ---------------------------------------------------------------

  async createTenant(input: SesCreateTenantInput): Promise<SesTenant> {
    try {
      const response = await this.call<CreateTenantResponse>(
        "createTenant",
        new CreateTenantCommand({
          TenantName: input.tenantName,
          ...(input.tags ? { Tags: toTags(input.tags) } : {}),
        }),
      );
      return {
        name: response.TenantName ?? input.tenantName,
        id: response.TenantId ?? "",
        arn: response.TenantArn ?? "",
        sendingStatus:
          (response.SendingStatus as SesSendingStatus) ?? "ENABLED",
      };
    } catch (error) {
      // The ONE create verb that treats "already there" as success: a
      // provisioning step is re-driven after a transient failure, and failing
      // on its own previous success would strand a half-built stack.
      if (error instanceof SesError && error.kind === "already_exists") {
        return this.getTenant({ tenantName: input.tenantName });
      }
      throw error;
    }
  }

  async deleteTenant(input: SesTenantRef): Promise<void> {
    await this.call(
      "deleteTenant",
      new DeleteTenantCommand({ TenantName: input.tenantName }),
    );
  }

  async associateResource(input: SesResourceAssociationInput): Promise<void> {
    try {
      await this.call(
        "associateResource",
        new CreateTenantResourceAssociationCommand({
          TenantName: input.tenantName,
          ResourceArn: input.resourceArn,
        }),
      );
    } catch (error) {
      // An association is set membership. Re-asserting one is the same
      // statement, not a conflict, so a resumed provision must not break here.
      if (error instanceof SesError && error.kind === "already_exists") return;
      throw error;
    }
  }

  async disassociateResource(
    input: SesResourceAssociationInput,
  ): Promise<void> {
    await this.call(
      "disassociateResource",
      new DeleteTenantResourceAssociationCommand({
        TenantName: input.tenantName,
        ResourceArn: input.resourceArn,
      }),
    );
  }

  // -- Configuration set ----------------------------------------------------

  async createConfigurationSet(
    input: SesCreateConfigurationSetInput,
  ): Promise<void> {
    await this.call(
      "createConfigurationSet",
      new CreateConfigurationSetCommand({
        ConfigurationSetName: input.configurationSetName,
        // Two things deliberately NOT sent here:
        //  - `TrackingOptions`: provider-native open/click tracking stays OFF,
        //    because Hogsend's tracking is first-party and sovereign, and
        //    letting SES rewrite links too would double-count every click;
        //  - `SuppressionOptions`: suppression is a TENANT decision
        //    (`putSuppressionScope`), and a second place to set it here would
        //    be a second place to get it wrong.
        ...(input.tags ? { Tags: toTags(input.tags) } : {}),
      }),
    );
  }

  async deleteConfigurationSet(input: SesConfigurationSetRef): Promise<void> {
    await this.call(
      "deleteConfigurationSet",
      new DeleteConfigurationSetCommand({
        ConfigurationSetName: input.configurationSetName,
      }),
    );
  }

  /**
   * `PutTenantSuppressionAttributes` — a TENANT operation.
   *
   * NOT `PutConfigurationSetSuppressionOptions`, which takes no tenant and
   * cannot put a tenant onto its own suppression list. Wiring that one would
   * leave every tenant on the ACCOUNT list, so one customer's hard bounce would
   * suppress that address for all of them, silently and with no error anywhere
   * — the exact cross-tenant leak the tenant model exists to prevent.
   */
  async putSuppressionScope(input: SesPutSuppressionScopeInput): Promise<void> {
    await this.call(
      "putSuppressionScope",
      new PutTenantSuppressionAttributesCommand({
        TenantName: input.tenantName,
        SuppressionScope: input.scope,
        ...(input.reasons ? { SuppressedReasons: input.reasons } : {}),
      }),
    );
  }

  async putEventDestination(input: SesPutEventDestinationInput): Promise<void> {
    const destination = {
      Enabled: input.enabled ?? true,
      MatchingEventTypes: input.eventTypes,
      SnsDestination: { TopicArn: input.snsTopicArn },
    };
    try {
      await this.call(
        "putEventDestination",
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: input.configurationSetName,
          EventDestinationName: input.eventDestinationName,
          EventDestination: destination,
        }),
      );
    } catch (error) {
      // A verb called `put` has to BE a put: AWS only offers create-or-update
      // as two calls, so the second one lives here rather than in every caller.
      if (!(error instanceof SesError) || error.kind !== "already_exists") {
        throw error;
      }
      await this.call(
        "putEventDestination",
        new UpdateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: input.configurationSetName,
          EventDestinationName: input.eventDestinationName,
          EventDestination: destination,
        }),
      );
    }
  }

  // -- Identity -------------------------------------------------------------

  async createIdentity(input: SesCreateIdentityInput): Promise<SesIdentity> {
    const response = await this.call<CreateEmailIdentityResponse>(
      "createIdentity",
      new CreateEmailIdentityCommand({
        EmailIdentity: input.domain,
        ...(input.configurationSetName
          ? { ConfigurationSetName: input.configurationSetName }
          : {}),
        ...(input.dkim
          ? {
              DkimSigningAttributes: {
                DomainSigningSelector: input.dkim.selector,
                DomainSigningPrivateKey: input.dkim.privateKey,
                // BYODKIM: ONE TXT record verifies the domain, versus Easy
                // DKIM's three CNAMEs (DECISIONS §2).
                DomainSigningAttributesOrigin: "EXTERNAL",
                // 2048-bit, where Resend signs with 1024.
                NextSigningKeyLength: "RSA_2048_BIT",
              },
            }
          : {}),
        ...(input.tags ? { Tags: toTags(input.tags) } : {}),
      }),
    );

    const verifiedForSending = response.VerifiedForSendingStatus ?? false;
    return {
      identity: input.domain,
      verifiedForSending,
      // `CreateEmailIdentity` does not return a verification status — it is a
      // freshly created identity, so DKIM's own status is the honest answer.
      verificationStatus: verifiedForSending
        ? "SUCCESS"
        : ((response.DkimAttributes?.Status as SesVerificationStatus) ??
          "PENDING"),
      dkim: toDkim(response.DkimAttributes),
      ...(input.configurationSetName
        ? { configurationSetName: input.configurationSetName }
        : {}),
    };
  }

  async getIdentity(input: SesIdentityRef): Promise<SesIdentity> {
    const response = await this.call<GetEmailIdentityResponse>(
      "getIdentity",
      new GetEmailIdentityCommand({ EmailIdentity: input.identity }),
    );

    const verifiedForSending = response.VerifiedForSendingStatus ?? false;
    // A MAIL FROM with no domain is not a MAIL FROM. AWS types the field as
    // required and still ships it optional, so read it once and branch on the
    // value rather than on the presence of its container.
    const mailFromDomain = response.MailFromAttributes?.MailFromDomain;
    return {
      identity: input.identity,
      verifiedForSending,
      verificationStatus:
        (response.VerificationStatus as SesVerificationStatus) ??
        (verifiedForSending ? "SUCCESS" : "PENDING"),
      dkim: toDkim(response.DkimAttributes),
      ...(mailFromDomain
        ? {
            mailFrom: {
              domain: mailFromDomain,
              status: response.MailFromAttributes
                ?.MailFromDomainStatus as SesMailFromStatus,
              behaviorOnMxFailure:
                response.MailFromAttributes?.BehaviorOnMxFailure ===
                "REJECT_MESSAGE"
                  ? "REJECT_MESSAGE"
                  : "USE_DEFAULT_VALUE",
            },
          }
        : {}),
      ...(response.ConfigurationSetName
        ? { configurationSetName: response.ConfigurationSetName }
        : {}),
    };
  }

  async setMailFrom(input: SesSetMailFromInput): Promise<void> {
    await this.call(
      "setMailFrom",
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: input.identity,
        MailFromDomain: input.mailFromDomain,
        // Default keeps sending through amazonses.com if the branded MX is not
        // there yet; rejecting would make a half-published DNS zone a hard
        // outage rather than a cosmetic one.
        BehaviorOnMxFailure: input.behaviorOnMxFailure ?? "USE_DEFAULT_VALUE",
      }),
    );
  }

  async deleteIdentity(input: SesIdentityRef): Promise<void> {
    await this.call(
      "deleteIdentity",
      new DeleteEmailIdentityCommand({ EmailIdentity: input.identity }),
    );
  }

  // -- Reputation -----------------------------------------------------------

  async setReputationPolicy(input: SesSetReputationPolicyInput): Promise<void> {
    const tenant = await this.getTenant({ tenantName: input.tenantName });
    await this.call(
      "setReputationPolicy",
      new UpdateReputationEntityPolicyCommand({
        ReputationEntityType: "RESOURCE",
        // The tenant ARN, never the name — hence the read above.
        ReputationEntityReference: tenant.arn,
        // And the policy is itself an AWS-OWNED ARN, not the bare word.
        ReputationEntityPolicy: reputationPolicyArn(
          this.awsRegion,
          input.policy,
        ),
      }),
    );
  }

  async setTenantSendingStatus(
    input: SesSetTenantSendingStatusInput,
  ): Promise<void> {
    const tenant = await this.getTenant({ tenantName: input.tenantName });
    await this.call(
      "setTenantSendingStatus",
      new UpdateReputationEntityCustomerManagedStatusCommand({
        ReputationEntityType: "RESOURCE",
        ReputationEntityReference: tenant.arn,
        SendingStatus: input.status,
      }),
    );
  }

  async getReputationEntity(
    input: SesReputationEntityRef,
  ): Promise<SesReputationEntity> {
    // AWS addresses a reputation entity by ARN; this seam addresses it by
    // tenant name, like every other reputation verb. A caller that already
    // stored the ARN hands it over and skips the extra rate-limited call.
    const reference =
      input.tenantArn ??
      (await this.getTenant({ tenantName: input.tenantName })).arn;
    const response = await this.call<GetReputationEntityResponse>(
      "getReputationEntity",
      new GetReputationEntityCommand({
        ReputationEntityType: "RESOURCE",
        ReputationEntityReference: reference,
      }),
    );
    const entity = response.ReputationEntity;
    if (!entity) {
      throw new SesError(
        `SES reputation entity "${input.tenantArn}" was not returned`,
        { kind: "not_found", operation: "getReputationEntity" },
      );
    }

    const policy = parseReputationPolicy(entity.ReputationManagementPolicy);
    return {
      reference: entity.ReputationEntityReference ?? reference,
      ...(entity.SendingStatusAggregate
        ? { sendingStatus: entity.SendingStatusAggregate as SesSendingStatus }
        : {}),
      ...(policy ? { policy } : {}),
      // The raw ARN rides along whether or not it parsed: an unrecognised
      // policy is exactly the case where a reader needs AWS's own answer.
      ...(entity.ReputationManagementPolicy
        ? { policyArn: entity.ReputationManagementPolicy }
        : {}),
      ...(toStatusRecord(entity.CustomerManagedStatus)
        ? {
            customerManagedStatus: toStatusRecord(entity.CustomerManagedStatus),
          }
        : {}),
      ...(toStatusRecord(entity.AwsSesManagedStatus)
        ? { awsSesManagedStatus: toStatusRecord(entity.AwsSesManagedStatus) }
        : {}),
      ...(entity.ReputationImpact
        ? { impact: entity.ReputationImpact as SesRecommendationImpact }
        : {}),
    };
  }

  async listRecommendations(
    input: SesListRecommendationsInput = {},
  ): Promise<SesRecommendationsPage> {
    const filter = {
      ...(input.resourceArn ? { RESOURCE_ARN: input.resourceArn } : {}),
      ...(input.status ? { STATUS: input.status } : {}),
      ...(input.impact ? { IMPACT: input.impact } : {}),
      ...(input.type ? { TYPE: input.type } : {}),
    };
    const response = await this.call<ListRecommendationsResponse>(
      "listRecommendations",
      new ListRecommendationsCommand({
        ...(Object.keys(filter).length > 0 ? { Filter: filter } : {}),
        ...(input.pageSize ? { PageSize: input.pageSize } : {}),
        ...(input.nextToken ? { NextToken: input.nextToken } : {}),
      }),
    );

    return {
      recommendations: (response.Recommendations ?? []).map(toRecommendation),
      ...(response.NextToken ? { nextToken: response.NextToken } : {}),
    };
  }

  /**
   * The tenant read-back.
   *
   * A first-class verb rather than a private helper, because `CreateTenant`
   * hands back the ARN ONLY on the call that creates the tenant: every later
   * reader — the idempotent create below, both reputation writes, PRD 08's
   * reconciler — has no other way to learn it.
   */
  async getTenant(input: SesTenantRef): Promise<SesTenant> {
    const { tenantName } = input;
    const response = await this.call<GetTenantResponse>(
      "getTenant",
      new GetTenantCommand({ TenantName: tenantName }),
    );
    const tenant = response.Tenant;
    if (!tenant) {
      throw new SesError(`SES tenant "${tenantName}" was not returned`, {
        kind: "not_found",
        operation: "getTenant",
      });
    }
    return {
      name: tenant.TenantName ?? tenantName,
      id: tenant.TenantId ?? "",
      arn: tenant.TenantArn ?? "",
      sendingStatus: (tenant.SendingStatus as SesSendingStatus) ?? "ENABLED",
    };
  }

  /**
   * Execute one command with the seam's retry policy.
   *
   * The guard below is the single most load-bearing line in this file: a 4xx
   * will answer identically forever, so retrying it burns the caller's attempt
   * budget and — on a send — risks a duplicate delivery.
   */
  private async call<T>(
    operation: string,
    command: SesCommandLike,
  ): Promise<T> {
    let last: SesError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return (await this.transport(command)) as T;
      } catch (cause) {
        const error = classifySesError(cause, operation);
        if (!error.retryable) throw error;
        last = error;
        if (attempt < this.maxAttempts) {
          await this.sleep(sesBackoffMs(attempt));
        }
      }
    }

    // Exhausted. `transient` rather than the last kind, so a caller sees one
    // answer for "SES would not settle" — and the body still rides along.
    throw new SesError(
      `SES ${operation} did not succeed after ${this.maxAttempts} attempts: ${
        last?.message ?? "unknown error"
      }`,
      {
        kind: "transient",
        operation,
        ...(last?.detail === undefined ? {} : { detail: last.detail }),
        ...(last?.httpStatusCode === undefined
          ? {}
          : { httpStatusCode: last.httpStatusCode }),
        ...(last?.awsErrorName === undefined
          ? {}
          : { awsErrorName: last.awsErrorName }),
        cause: last,
      },
    );
  }
}

/**
 * Build the real wire.
 *
 * `maxAttempts: 1` turns the SDK's OWN retry loop OFF. The policy has to live
 * in exactly one place, or "never retry a 4xx" becomes a claim about our loop
 * that a middleware underneath it can quietly break.
 */
function realTransport(
  region: SesRegion,
  credentials: AwsSesCredentials | undefined,
): SesTransport {
  const client = new SESv2Client({
    region,
    maxAttempts: 1,
    ...(credentials ? { credentials } : {}),
  });
  // The SDK's `send` is overloaded per command; the seam deliberately holds the
  // union, so ONE cast lives here and nowhere else.
  return (command) => client.send(command as never);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** A tenant-scoped pause, as opposed to the account's. Both halves required. */
const TENANT_MARKER = /tenant/i;
const PAUSED_MARKER = /(paus|disabl|suspend)/i;

/**
 * A fault with no HTTP status: DNS, a reset, a timeout. Always worth another
 * attempt, and matched on text because that is all a thrown transport gives us.
 */
const NETWORK_MARKER =
  /(econnreset|econnrefused|econnaborted|epipe|enotfound|eai_again|socket hang up|fetch failed|network|timeout|timed out|aborted)/i;

const NOT_RETRYABLE_BY_NAME: Record<string, SesErrorKind> = {
  NotFoundException: "not_found",
  AlreadyExistsException: "already_exists",
  AccountSuspendedException: "account_paused",
  BadRequestException: "invalid",
  ValidationException: "invalid",
  // "Too many INSTANCES of the specified resource type" — a quota, not a
  // throttle. Waiting does not create room.
  LimitExceededException: "invalid",
  MailFromDomainNotVerifiedException: "invalid",
  InvalidNextTokenException: "invalid",
  // "An ongoing account details update is under review" — a human resolves it.
  ConflictException: "invalid",
};

const THROTTLE_NAMES = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "Throttling",
  "RequestThrottled",
  "RequestThrottledException",
  "SlowDown",
]);

const TRANSIENT_NAMES = new Set([
  // "$fault: server" in the SDK's own model: the resource is mid-modification
  // and a backoff is exactly the right answer.
  "ConcurrentModificationException",
  "InternalServiceErrorException",
  "InternalFailure",
  "ServiceUnavailable",
  "ServiceUnavailableException",
]);

interface AwsErrorShape {
  name: string;
  message: string;
  status?: number;
  requestId?: string;
  fault?: string;
  body?: string;
}

/**
 * Turn anything AWS (or the network) threw into a classified `SesError`.
 *
 * Classification is by ERROR NAME first, then HTTP status, then the shape of a
 * transport failure — never by matching a prose message, except for the one
 * distinction AWS does not model structurally (an account pause versus a
 * tenant one), which is called out where it happens.
 */
export function classifySesError(cause: unknown, operation?: string): SesError {
  if (cause instanceof SesError) return cause;

  const shape = readAwsError(cause);
  const kind = classifyKind(shape);
  const detail = truncate(shape.body ?? shape.message);

  return new SesError(
    `SES ${operation ?? "request"} failed (${shape.name}${
      shape.status === undefined ? "" : `, HTTP ${shape.status}`
    }): ${detail}`,
    {
      kind,
      ...(operation === undefined ? {} : { operation }),
      detail,
      awsErrorName: shape.name,
      ...(shape.status === undefined ? {} : { httpStatusCode: shape.status }),
      ...(shape.requestId === undefined ? {} : { requestId: shape.requestId }),
      cause,
    },
  );
}

function classifyKind(shape: AwsErrorShape): SesErrorKind {
  if (THROTTLE_NAMES.has(shape.name)) return "throttled";
  if (TRANSIENT_NAMES.has(shape.name)) return "transient";

  // The one place prose is read: SES reports both the account pause and the
  // tenant pause through the same exception names, and the difference decides
  // whether ONE customer is down or all of them.
  const tenantScoped =
    TENANT_MARKER.test(shape.message) && PAUSED_MARKER.test(shape.message);
  if (shape.name === "SendingPausedException") {
    return tenantScoped ? "tenant_paused" : "account_paused";
  }
  if (shape.name === "MessageRejected") {
    return tenantScoped ? "tenant_paused" : "invalid";
  }

  const byName = NOT_RETRYABLE_BY_NAME[shape.name];
  if (byName) return byName;

  if (shape.status !== undefined) {
    if (shape.status === 429) return "throttled";
    if (shape.status >= 500) return "transient";
    // An unrecognised 4xx is still a 4xx: permanent, and never retried.
    if (shape.status >= 400) return "invalid";
  }

  if (shape.fault === "server") return "transient";
  if (NETWORK_MARKER.test(`${shape.name} ${shape.message}`)) return "transient";

  // Unrecognised, and therefore NOT retryable: the default has to be "do not
  // repeat an operation we do not understand".
  return "unknown";
}

function readAwsError(cause: unknown): AwsErrorShape {
  if (typeof cause !== "object" || cause === null) {
    return { name: "Error", message: String(cause) };
  }

  const error = cause as {
    name?: unknown;
    message?: unknown;
    $fault?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
    $response?: { statusCode?: unknown; body?: unknown };
  };

  const status =
    typeof error.$metadata?.httpStatusCode === "number"
      ? error.$metadata.httpStatusCode
      : typeof error.$response?.statusCode === "number"
        ? error.$response.statusCode
        : undefined;

  const body = readBody(error.$response?.body);

  return {
    name: typeof error.name === "string" ? error.name : "Error",
    message: typeof error.message === "string" ? error.message : String(cause),
    ...(status === undefined ? {} : { status }),
    ...(typeof error.$metadata?.requestId === "string"
      ? { requestId: error.$metadata.requestId }
      : {}),
    ...(typeof error.$fault === "string" ? { fault: error.$fault } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

/** The response body, whatever form it arrived in. NEVER dropped: without it a
 * `BadRequestException` in a log says nothing at all. */
function readBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function truncate(value: string, max = MAX_DETAIL_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---------------------------------------------------------------------------
// Shape translation
// ---------------------------------------------------------------------------

function toSendEmailFields(message: SesMessage): {
  FromEmailAddress: string;
  Destination: {
    ToAddresses: string[];
    CcAddresses?: string[];
    BccAddresses?: string[];
  };
  ReplyToAddresses?: string[];
  Content: object;
  EmailTags?: { Name: string; Value: string }[];
} {
  return {
    FromEmailAddress: message.from,
    Destination: {
      ToAddresses: message.to,
      ...(message.cc ? { CcAddresses: message.cc } : {}),
      ...(message.bcc ? { BccAddresses: message.bcc } : {}),
    },
    ...(message.replyTo ? { ReplyToAddresses: message.replyTo } : {}),
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          ...(message.html
            ? { Html: { Data: message.html, Charset: "UTF-8" } }
            : {}),
          ...(message.text
            ? { Text: { Data: message.text, Charset: "UTF-8" } }
            : {}),
        },
        ...(message.headers
          ? {
              Headers: Object.entries(message.headers).map(([Name, Value]) => ({
                Name,
                Value,
              })),
            }
          : {}),
      },
    },
    ...(message.tags
      ? {
          EmailTags: message.tags.map((tag) => ({
            Name: tag.name,
            Value: tag.value,
          })),
        }
      : {}),
  };
}

function toTags(
  tags: Record<string, string>,
): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/**
 * The reputation policy is an AWS-OWNED ARN, not the bare word: sending
 * `"STRICT"` is a validation error at best and a silently ignored policy at
 * worst. Built from the CLIENT's region, since a policy ARN is region-scoped
 * exactly like the tenant it applies to.
 */
export function reputationPolicyArn(
  region: SesRegion,
  policy: SesReputationPolicy,
): string {
  return `arn:aws:ses:${region}:aws:reputation-policy/${policy.toLowerCase()}`;
}

/** The same ARN read back into our vocabulary, so a write and a read
 * round-trip. Unrecognised → undefined, and the caller keeps the raw ARN. */
function parseReputationPolicy(
  arn: string | undefined,
): SesReputationPolicy | undefined {
  const slug = arn?.split("/").pop()?.toUpperCase();
  return slug === "STANDARD" || slug === "STRICT" || slug === "NONE"
    ? slug
    : undefined;
}

function toStatusRecord(
  record:
    | { Status?: string; Cause?: string; LastUpdatedTimestamp?: Date }
    | undefined,
): SesReputationStatusRecord | undefined {
  if (!record?.Status) return undefined;
  return {
    status: record.Status as SesSendingStatus,
    ...(record.Cause ? { cause: record.Cause } : {}),
    ...(record.LastUpdatedTimestamp
      ? { lastUpdatedAt: record.LastUpdatedTimestamp.toISOString() }
      : {}),
  };
}

function toDkim(
  attributes:
    | {
        Status?: string;
        SigningEnabled?: boolean;
        SigningAttributesOrigin?: string;
        Tokens?: string[];
      }
    | undefined,
): SesIdentity["dkim"] {
  return {
    status: (attributes?.Status as SesDkimStatus) ?? "PENDING",
    signingEnabled: attributes?.SigningEnabled ?? false,
    // AWS reports Easy DKIM as a per-region `AWS_SES_*` variant; collapse the
    // whole family, because the only thing above the seam cares about is
    // "did we bring our own key".
    origin: normalizeDkimOrigin(attributes?.SigningAttributesOrigin),
    tokens: attributes?.Tokens ?? [],
  };
}

function normalizeDkimOrigin(origin: string | undefined): SesDkimOrigin {
  return origin === "EXTERNAL" ? "EXTERNAL" : "AWS_SES";
}

function toRecommendation(recommendation: {
  ResourceArn?: string;
  Type?: string;
  Status?: string;
  Impact?: string;
  Description?: string;
  CreatedTimestamp?: Date;
  LastUpdatedTimestamp?: Date;
}): SesRecommendation {
  return {
    ...(recommendation.ResourceArn
      ? { resourceArn: recommendation.ResourceArn }
      : {}),
    ...(recommendation.Type
      ? { type: recommendation.Type as SesRecommendationType }
      : {}),
    ...(recommendation.Status
      ? { status: recommendation.Status as SesRecommendationStatus }
      : {}),
    ...(recommendation.Impact
      ? { impact: recommendation.Impact as SesRecommendationImpact }
      : {}),
    ...(recommendation.Description
      ? { description: recommendation.Description }
      : {}),
    // ISO strings, not `Date`s: this survives a jsonb round trip, and a `Date`
    // would not.
    ...(recommendation.CreatedTimestamp
      ? { createdAt: recommendation.CreatedTimestamp.toISOString() }
      : {}),
    ...(recommendation.LastUpdatedTimestamp
      ? { lastUpdatedAt: recommendation.LastUpdatedTimestamp.toISOString() }
      : {}),
  };
}
