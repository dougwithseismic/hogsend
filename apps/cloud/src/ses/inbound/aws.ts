import type {
  DescribeActiveReceiptRuleSetResponse,
  DescribeReceiptRuleResponse,
  DescribeReceiptRuleSetResponse,
  ReceiptAction,
  ReceiptRule,
} from "@aws-sdk/client-ses";
import {
  CreateReceiptRuleCommand,
  CreateReceiptRuleSetCommand,
  DeleteReceiptRuleCommand,
  DeleteReceiptRuleSetCommand,
  DescribeActiveReceiptRuleSetCommand,
  DescribeReceiptRuleCommand,
  DescribeReceiptRuleSetCommand,
  SESClient,
  SetActiveReceiptRuleSetCommand,
  UpdateReceiptRuleCommand,
} from "@aws-sdk/client-ses";
import type { SubstrateRegion } from "../../substrate/types";
import {
  type AwsSesCredentials,
  classifySesError,
  SES_MAX_ATTEMPTS,
  type SesCommandLike,
  type SesTransport,
  type SleepFn,
  sesBackoffMs,
} from "../aws";
import { resolveSesRegion } from "../contract";
import { SesError, type SesErrorKind, type SesRegion } from "../types";
import {
  assertPutRuleInput,
  assertRuleName,
  assertRuleSetName,
  resolveSesInboundEndpoint,
  type SesInboundClient,
} from "./contract";
import {
  SES_INBOUND_DEFAULT_ENABLED,
  SES_INBOUND_DEFAULT_SCAN_ENABLED,
  SES_INBOUND_DEFAULT_TLS_POLICY,
  type SesInboundAction,
  type SesInboundActiveRuleSet,
  type SesInboundPutRuleInput,
  type SesInboundRule,
  type SesInboundRuleRef,
  type SesInboundRuleSet,
  type SesInboundRuleSetRef,
  type SesInboundSetActiveInput,
  type SesInboundTlsPolicy,
} from "./types";

/**
 * The real inbound client, over `@aws-sdk/client-ses` — SES **v1**.
 *
 * A second AWS SDK in this app, and not by preference: the v2 client the rest
 * of the stack uses has no receipt-rule operation of any kind. The two clients
 * share credentials and the region mapping and nothing else, which is why this
 * file re-uses `classifySesError`'s shape-reading and then OVERRIDES the kinds
 * it gets wrong — v1's error vocabulary is entirely its own.
 *
 * Three things it owns, because nothing above the seam may know them:
 *  - which v1 command implements each of our eight contract verbs;
 *  - the retry policy, which NEVER retries a 4xx;
 *  - the translation of every AWS failure into a classified `SesError`.
 */

export const AWS_SES_INBOUND_ID = "aws";

export interface AwsSesInboundClientOptions {
  region: SubstrateRegion;
  /** Absent → the SDK's default credential chain (never used on Railway). */
  credentials?: AwsSesCredentials;
  send?: SesTransport;
  sleep?: SleepFn;
  maxAttempts?: number;
}

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AwsSesInboundClient implements SesInboundClient {
  readonly id = AWS_SES_INBOUND_ID;
  readonly region: SubstrateRegion;
  readonly awsRegion: SesRegion;
  readonly inboundEndpoint: string;

  private readonly transport: SesTransport;
  private readonly sleep: SleepFn;
  private readonly maxAttempts: number;

  constructor(options: AwsSesInboundClientOptions) {
    this.awsRegion = resolveSesRegion(options.region);
    // TWO lookups, deliberately, and in this order: a region this stack can
    // send from is not evidence that it can receive.
    this.inboundEndpoint = resolveSesInboundEndpoint(this.awsRegion);
    this.region = options.region;
    this.transport =
      options.send ?? realTransport(this.awsRegion, options.credentials);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = options.maxAttempts ?? SES_MAX_ATTEMPTS;
  }

  // -- Rule set -------------------------------------------------------------

  async createRuleSet(input: SesInboundRuleSetRef): Promise<void> {
    assertRuleSetName(input.ruleSetName);
    await this.call(
      "createRuleSet",
      new CreateReceiptRuleSetCommand({ RuleSetName: input.ruleSetName }),
    );
  }

  async getRuleSet(input: SesInboundRuleSetRef): Promise<SesInboundRuleSet> {
    const response = await this.call<DescribeReceiptRuleSetResponse>(
      "getRuleSet",
      new DescribeReceiptRuleSetCommand({ RuleSetName: input.ruleSetName }),
    );
    return {
      // AWS echoes the name on `Metadata`; fall back to the input rather than
      // to an empty string, so a caller never reads a rule set with no name.
      ruleSetName: response.Metadata?.Name ?? input.ruleSetName,
      rules: (response.Rules ?? []).map(toInboundRule),
    };
  }

  async deleteRuleSet(input: SesInboundRuleSetRef): Promise<void> {
    await this.call(
      "deleteRuleSet",
      new DeleteReceiptRuleSetCommand({ RuleSetName: input.ruleSetName }),
    );
  }

  // -- The one active rule set ----------------------------------------------

  async getActiveRuleSet(): Promise<SesInboundActiveRuleSet> {
    const response = await this.call<DescribeActiveReceiptRuleSetResponse>(
      "getActiveRuleSet",
      new DescribeActiveReceiptRuleSetCommand({}),
    );
    // The name is OMITTED rather than emptied when nothing is active: "no rule
    // set is receiving mail" and "a rule set named `''`" are different facts,
    // and a caller branches on the first.
    return {
      ...(response.Metadata?.Name
        ? { ruleSetName: response.Metadata.Name }
        : {}),
      rules: (response.Rules ?? []).map(toInboundRule),
    };
  }

  async setActiveRuleSet(input: SesInboundSetActiveInput): Promise<void> {
    if (input.ruleSetName !== null) assertRuleSetName(input.ruleSetName);
    await this.call(
      "setActiveRuleSet",
      new SetActiveReceiptRuleSetCommand(
        // OMITTED, not sent as an explicit null: `RuleSetName` is modelled
        // "Required: No" and the v1 query protocol has no null to serialise.
        // Omission is how AWS spells "disable all email receiving".
        input.ruleSetName === null ? {} : { RuleSetName: input.ruleSetName },
      ),
    );
  }

  // -- Rule ------------------------------------------------------------------

  async putRule(input: SesInboundPutRuleInput): Promise<void> {
    assertPutRuleInput(input);
    const command = {
      RuleSetName: input.ruleSetName,
      Rule: toAwsRule(input),
    };
    try {
      await this.call("putRule", new CreateReceiptRuleCommand(command));
    } catch (error) {
      // A verb called `put` has to BE a put: AWS offers create-or-update as two
      // calls, so the second one lives here rather than in every caller.
      if (!(error instanceof SesError) || error.kind !== "already_exists") {
        throw error;
      }
      // The SAME rule body. `UpdateReceiptRule` takes a whole `ReceiptRule`, so
      // this is a REPLACE — which is exactly what a re-driven provisioning step
      // means by "make it look like this".
      await this.call("putRule", new UpdateReceiptRuleCommand(command));
    }
  }

  async getRule(input: SesInboundRuleRef): Promise<SesInboundRule> {
    const response = await this.call<DescribeReceiptRuleResponse>(
      "getRule",
      new DescribeReceiptRuleCommand({
        RuleSetName: input.ruleSetName,
        RuleName: input.ruleName,
      }),
    );
    const rule = response.Rule;
    if (!rule) {
      throw new SesError(
        `SES receipt rule "${input.ruleName}" was not returned`,
        { kind: "not_found", operation: "getRule" },
      );
    }
    return toInboundRule(rule);
  }

  async deleteRule(input: SesInboundRuleRef): Promise<void> {
    assertRuleName(input.ruleName);
    await this.call(
      "deleteRule",
      new DeleteReceiptRuleCommand({
        RuleSetName: input.ruleSetName,
        RuleName: input.ruleName,
      }),
    );
  }

  /**
   * Execute one command with the seam's retry policy.
   *
   * Same policy as the outbound client, and the 4xx guard is just as
   * load-bearing — but the retryable case matters MORE here: every v1
   * receipt-rule operation is capped at one request per second, so a
   * provisioning burst earns a throttle the send path would never see.
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
        const error = classifySesInboundError(cause, operation);
        if (!error.retryable) throw error;
        last = error;
        if (attempt < this.maxAttempts) {
          await this.sleep(sesBackoffMs(attempt));
        }
      }
    }

    throw new SesError(
      `SES inbound ${operation} did not succeed after ${this.maxAttempts} attempts: ${
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
 * `maxAttempts: 1` turns the SDK's OWN retry loop OFF, for the same reason the
 * outbound client does: the policy has to live in exactly one place, or "never
 * retry a 4xx" becomes a claim about our loop that a middleware underneath it
 * can quietly break.
 */
function realTransport(
  region: SesRegion,
  credentials: AwsSesCredentials | undefined,
): SesTransport {
  const client = new SESClient({
    region,
    maxAttempts: 1,
    ...(credentials ? { credentials } : {}),
  });
  return (command) => client.send(command as never);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * SES v1's error names, keyed WITHOUT the `Exception` suffix.
 *
 * v1 is the query protocol, so the wire code is `RuleSetDoesNotExist` while the
 * SDK's modelled class sets `name` to `RuleSetDoesNotExistException`. Which of
 * the two reaches `error.name` depends on SDK internals we have not observed
 * live, and the cost of guessing wrong is a teardown that can never recognise
 * "already gone" — so the lookup strips the suffix and both spellings land
 * here.
 *
 * None of these names exist in the v2 map next door, which is the concrete
 * reason this seam could not have shared that classifier: without this table
 * every one of them falls through to "unrecognised 4xx" and classifies as
 * `invalid`.
 */
const INBOUND_KIND_BY_NAME: Record<string, SesErrorKind> = {
  AlreadyExists: "already_exists",
  RuleDoesNotExist: "not_found",
  RuleSetDoesNotExist: "not_found",
  // "The delete operation could not be completed" — the ACTIVE rule set cannot
  // be deleted. Permanent until something deactivates it; a retry cannot.
  CannotDelete: "invalid",
  // A quota ("could not be created because of service limits"), not a throttle.
  // Waiting does not create room — the same call the outbound seam makes.
  LimitExceeded: "invalid",
  // SES "could not publish to the bucket/topic, possibly due to permissions
  // issues". A retry cannot grant a permission.
  InvalidS3Configuration: "invalid",
  InvalidSnsTopic: "invalid",
  InvalidLambdaFunction: "invalid",
};

/**
 * Turn anything the v1 wire threw into a classified `SesError`.
 *
 * Layered rather than rewritten: `classifySesError` already owns the shape
 * reading (status, request id, the response body that must never be
 * discarded), the network-fault markers and the status fallbacks, and all of
 * that is API-version-neutral. Only the NAME→kind table differs between v1 and
 * v2, so only that is overridden here.
 */
export function classifySesInboundError(
  cause: unknown,
  operation?: string,
): SesError {
  if (cause instanceof SesError) return cause;

  const base = classifySesError(cause, operation);
  const name = (base.awsErrorName ?? "").replace(/Exception$/, "");
  const kind = INBOUND_KIND_BY_NAME[name];
  if (kind === undefined || kind === base.kind) return base;

  return new SesError(base.message, {
    kind,
    ...(operation === undefined ? {} : { operation }),
    ...(base.detail === undefined ? {} : { detail: base.detail }),
    ...(base.awsErrorName === undefined
      ? {}
      : { awsErrorName: base.awsErrorName }),
    ...(base.httpStatusCode === undefined
      ? {}
      : { httpStatusCode: base.httpStatusCode }),
    ...(base.requestId === undefined ? {} : { requestId: base.requestId }),
    cause,
  });
}

// ---------------------------------------------------------------------------
// Shape translation
// ---------------------------------------------------------------------------

/**
 * One neutral put onto AWS's `ReceiptRule`.
 *
 * `Enabled`, `ScanEnabled` and `TlsPolicy` are ALWAYS sent, never left to AWS's
 * defaults. `Enabled` defaults to false there, so an omitted field would create
 * a rule that exists, reads back cleanly and silently receives nothing; and
 * AWS's two documents disagree about `ScanEnabled`'s default (API reference:
 * false; developer guide: "By default SES scans received email content for
 * malware"), which sending it explicitly makes moot.
 *
 * Exactly ONE action, and it is the S3 one carrying a topic. SNS alone caps a
 * message at 150 KB against S3's 40 MB, so an SNS-only rule passes every test
 * fixture and fails on the first reply with a photo attached.
 */
function toAwsRule(input: SesInboundPutRuleInput): ReceiptRule {
  return {
    Name: input.ruleName,
    Enabled: input.enabled ?? SES_INBOUND_DEFAULT_ENABLED,
    ScanEnabled: input.scanEnabled ?? SES_INBOUND_DEFAULT_SCAN_ENABLED,
    TlsPolicy: input.tlsPolicy ?? SES_INBOUND_DEFAULT_TLS_POLICY,
    Recipients: [...input.recipients],
    Actions: [
      {
        S3Action: {
          BucketName: input.store.bucketName,
          // Present because `assertStoreAction` refused the alternative.
          ...(input.store.topicArn ? { TopicArn: input.store.topicArn } : {}),
          ...(input.store.objectKeyPrefix
            ? { ObjectKeyPrefix: input.store.objectKeyPrefix }
            : {}),
          ...(input.store.kmsKeyArn
            ? { KmsKeyArn: input.store.kmsKeyArn }
            : {}),
          ...(input.store.iamRoleArn
            ? { IamRoleArn: input.store.iamRoleArn }
            : {}),
        },
      },
    ],
  };
}

/**
 * AWS's `ReceiptRule` back into ours.
 *
 * `Enabled` and `ScanEnabled` fall back to FALSE when absent, which is AWS's
 * own documented default — reading an absent field as `true` would be
 * inventing, and would report a dead rule as a live one.
 */
function toInboundRule(rule: ReceiptRule): SesInboundRule {
  return {
    ruleName: rule.Name ?? "",
    recipients: rule.Recipients ?? [],
    actions: (rule.Actions ?? []).map(toInboundAction),
    enabled: rule.Enabled ?? false,
    scanEnabled: rule.ScanEnabled ?? false,
    tlsPolicy: toTlsPolicy(rule.TlsPolicy),
  };
}

function toTlsPolicy(policy: string | undefined): SesInboundTlsPolicy {
  return policy === "Require" ? "Require" : "Optional";
}

/**
 * One AWS action into ours, NAMING anything we do not model.
 *
 * A rule can hold up to ten actions and this seam writes exactly one, so
 * everything else in here arrived from a console, another tool, or a future
 * PRD. Dropping it would hand a reconciler a rule that looks exactly like the
 * one we wrote — the PRD 14 failure on the read path. The neutral
 * `{ kind: "unsupported", awsType }` keeps the boundary intact (no SDK object
 * crosses it) while keeping the answer honest.
 */
function toInboundAction(action: ReceiptAction): SesInboundAction {
  const s3 = action.S3Action;
  if (s3?.BucketName) {
    return {
      kind: "store",
      bucketName: s3.BucketName,
      ...(s3.TopicArn ? { topicArn: s3.TopicArn } : {}),
      ...(s3.ObjectKeyPrefix ? { objectKeyPrefix: s3.ObjectKeyPrefix } : {}),
      ...(s3.KmsKeyArn ? { kmsKeyArn: s3.KmsKeyArn } : {}),
      ...(s3.IamRoleArn ? { iamRoleArn: s3.IamRoleArn } : {}),
    };
  }
  const [awsType] =
    Object.entries(action).find(([, value]) => value !== undefined) ?? [];
  return { kind: "unsupported", awsType: awsType ?? "unknown" };
}
