import {
  type DkimKeypair,
  type DnsRecord,
  dkimRecord,
  generateDkimKeypair,
} from "../lib/sending-domains";
import type { SesClient } from "../ses/contract";
import type { FakeSesClient } from "../ses/fake";
import {
  SesError,
  type SesEventType,
  type SesIdentity,
  type SesSuppressionReason,
  type SesTenant,
} from "../ses/types";
import { domainOfAddress, tenantScopedArn } from "./arns";
import { type CleanupReport, CleanupStack } from "./cleanup";
import {
  type Divergence,
  DivergenceRecorder,
  type RecordedStep,
} from "./divergence";
import type { WalkthroughOptions } from "./guards";
import type { WalkthroughNames } from "./naming";

/**
 * The walkthrough: every verb on the SES seam, run against the real client and
 * against a `FakeSesClient` driven through the identical sequence, in an order
 * where each step's answer feeds the next.
 *
 * ## What "seeded to the same state" means here
 *
 * The Fake is never pre-loaded with a guess about AWS. It is walked through the
 * SAME script, call for call, so at every step it holds whatever that history
 * would produce. The one exception is verification state, which AWS reaches by
 * a DNS poll we cannot wait for in a script: `__verifyIdentity` advances the
 * Fake explicitly at the single point where the real account already has a
 * verified identity (the operator's `--send-from`), and nowhere else.
 *
 * ## SES sandbox
 *
 * Sandbox restricts WHO you may send to and HOW MUCH — not the API surface.
 * Tenants, identity creation, BYODKIM, configuration sets and SNS event
 * destinations are all expected to work there, which is why this can run the
 * day the account exists rather than after production access is granted.
 * Anywhere that expectation is UNVERIFIED it is called out in a comment on the
 * step and echoed into the report's notes, rather than guessed at silently.
 *
 * ## The two legs that need an operator
 *
 * `putEventDestination` needs a real SNS topic in the same account and region,
 * and `sendEmail`/`sendBatch` need a verified sender (and, in sandbox, a
 * verified recipient). Without them the verbs are SKIPPED WITH A REASON that
 * lands in the report, never quietly passed over: a verb nobody exercised is a
 * verb whose Fake is still unproven, and the report has to say so.
 */

/** Both reasons, matching `SES_SUPPRESSED_REASONS` in the tenant service. */
const SUPPRESSED_REASONS: SesSuppressionReason[] = ["BOUNCE", "COMPLAINT"];

/** The four the configuration set publishes (`SES_PUBLISHED_EVENT_TYPES`). */
const PUBLISHED_EVENT_TYPES: SesEventType[] = [
  "DELIVERY",
  "BOUNCE",
  "COMPLAINT",
  "DELIVERY_DELAY",
];

/** Tags, so a leaked resource is identifiable in the console as well as by name. */
const WALKTHROUGH_TAGS = { hogsend: "ses-walkthrough" };

const REDACTED = "<redacted>";

export interface WalkthroughDkim {
  selector: string;
  /** What PRD 07 claims the customer publishes: ONE TXT record. */
  records: DnsRecord[];
  /** What AWS reported back. `EXTERNAL` is BYODKIM. */
  awsOrigin?: string;
  awsStatus?: string;
  /**
   * Easy DKIM's CNAME tokens. MUST be empty for BYODKIM — anything here means
   * AWS wants more than the one TXT record PRD 07 promises.
   */
  awsTokens: string[];
}

export interface ExecuteWalkthroughInput {
  real: SesClient;
  /** Driven through the identical sequence. Never pre-seeded. */
  fake: FakeSesClient;
  options: WalkthroughOptions;
  names: WalkthroughNames;
  /** Defaults to a fresh 2048-bit BYODKIM keypair, exactly as PRD 07 mints. */
  keypair?: DkimKeypair;
}

export interface ExecuteWalkthroughResult {
  steps: RecordedStep[];
  divergences: Divergence[];
  cleanup: CleanupReport;
  dkim: WalkthroughDkim;
  notes: string[];
  /** Set when a step's failure made the rest of the walk meaningless. */
  aborted?: string;
}

export async function executeWalkthrough(
  input: ExecuteWalkthroughInput,
): Promise<ExecuteWalkthroughResult> {
  const { real, fake, options, names } = input;
  const keypair = input.keypair ?? generateDkimKeypair();
  const recorder = new DivergenceRecorder();
  const cleanup = new CleanupStack();
  const notes: string[] = [];
  const dkim: WalkthroughDkim = {
    selector: keypair.selector,
    // The claim under test: ONE TXT record, carrying the public half of our own
    // 2048-bit key. Everything AWS reports below is compared against it.
    records: [dkimRecord(names.identityDomain, keypair.publicKey, "pending")],
    awsTokens: [],
  };

  let aborted: string | undefined;
  const finish = async (): Promise<ExecuteWalkthroughResult> => ({
    steps: recorder.steps,
    divergences: recorder.divergences,
    // ALWAYS, including on the abort path: the whole point of the stack.
    cleanup: await cleanup.run(),
    dkim,
    notes,
    ...(aborted === undefined ? {} : { aborted }),
  });

  // -- createTenant ---------------------------------------------------------
  const tenants = await recorder.compare<SesTenant>({
    verb: "createTenant",
    input: { tenantName: names.tenantName, tags: WALKTHROUGH_TAGS },
    // The id and the ARN carry the real account id; the Fake's are derived from
    // the name. Their SHAPE is still compared.
    volatile: ["id", "arn"],
    real: () =>
      real.createTenant({
        tenantName: names.tenantName,
        tags: WALKTHROUGH_TAGS,
      }),
    fake: () =>
      fake.createTenant({
        tenantName: names.tenantName,
        tags: WALKTHROUGH_TAGS,
      }),
    note: "AWS's TenantName charset and length limit are not restated in this repo; a rejection here is the finding.",
  });
  const realTenant = tenants.real;
  const fakeTenant = tenants.fake;
  if (!realTenant || !fakeTenant) {
    aborted =
      "createTenant did not succeed against AWS — nothing else can be walked without a tenant ARN";
    return finish();
  }
  cleanup.push(`delete-tenant ${names.tenantName}`, () =>
    tolerate(() => real.deleteTenant({ tenantName: names.tenantName })),
  );

  // -- getTenant ------------------------------------------------------------
  await recorder.compare({
    verb: "getTenant",
    input: { tenantName: names.tenantName },
    volatile: ["id", "arn"],
    real: () => real.getTenant({ tenantName: names.tenantName }),
    fake: () => fake.getTenant({ tenantName: names.tenantName }),
  });

  // -- putSuppressionScope --------------------------------------------------
  // THE line PRD 06 exists for: TENANT scope, addressed by tenant name. The
  // cross-tenant leak PRD 02 shipped was exactly this call reaching the
  // configuration-set operation instead, and no test could see it.
  await recorder.compare({
    verb: "putSuppressionScope",
    input: {
      tenantName: names.tenantName,
      scope: "TENANT",
      reasons: SUPPRESSED_REASONS,
    },
    real: () =>
      real.putSuppressionScope({
        tenantName: names.tenantName,
        scope: "TENANT",
        reasons: SUPPRESSED_REASONS,
      }),
    fake: () =>
      fake.putSuppressionScope({
        tenantName: names.tenantName,
        scope: "TENANT",
        reasons: SUPPRESSED_REASONS,
      }),
  });

  // -- createConfigurationSet -----------------------------------------------
  const configurationSet = await recorder.compare({
    verb: "createConfigurationSet",
    input: {
      configurationSetName: names.configurationSetName,
      tags: WALKTHROUGH_TAGS,
    },
    real: () =>
      real.createConfigurationSet({
        configurationSetName: names.configurationSetName,
        tags: WALKTHROUGH_TAGS,
      }),
    fake: () =>
      fake.createConfigurationSet({
        configurationSetName: names.configurationSetName,
        tags: WALKTHROUGH_TAGS,
      }),
  });
  if (configurationSet.ok) {
    cleanup.push(`delete-configuration-set ${names.configurationSetName}`, () =>
      tolerate(() =>
        real.deleteConfigurationSet({
          configurationSetName: names.configurationSetName,
        }),
      ),
    );
  }

  // -- putEventDestination --------------------------------------------------
  // UNVERIFIED sandbox claim: SNS event destinations are believed to work in
  // sandbox (sandbox bounds recipients and volume, not the API), but this has
  // not been confirmed against a live sandbox account. If AWS refuses here,
  // that refusal IS the finding — the report keeps its answer verbatim.
  if (options.snsTopicArn) {
    const destination = {
      configurationSetName: names.configurationSetName,
      eventDestinationName: names.eventDestinationName,
      snsTopicArn: options.snsTopicArn,
      eventTypes: PUBLISHED_EVENT_TYPES,
      enabled: true,
    };
    await recorder.compare({
      verb: "putEventDestination",
      input: destination,
      real: () => real.putEventDestination(destination),
      fake: () => fake.putEventDestination(destination),
      note: "sandbox-legality of SNS event destinations is unverified; a refusal here is a finding, not a bug in the script",
    });
    notes.push(
      `event destination published to ${options.snsTopicArn}; the topic policy must allow ses.amazonaws.com to publish or AWS refuses the attach`,
    );
  } else {
    recorder.skip({
      verb: "putEventDestination",
      reason:
        "no --sns-topic-arn: an event destination needs a real SNS topic in the same account and region",
    });
  }

  // -- associateResource (configuration set) --------------------------------
  const realConfigurationSetArn = tenantScopedArn(
    realTenant.arn,
    "configuration-set",
    names.configurationSetName,
  );
  const fakeConfigurationSetArn = tenantScopedArn(
    fakeTenant.arn,
    "configuration-set",
    names.configurationSetName,
  );
  const associatedSet = await recorder.compare({
    verb: "associateResource",
    label: "associateResource:configuration-set",
    input: {
      tenantName: names.tenantName,
      resourceArn: realConfigurationSetArn,
    },
    real: () =>
      real.associateResource({
        tenantName: names.tenantName,
        resourceArn: realConfigurationSetArn,
      }),
    fake: () =>
      fake.associateResource({
        tenantName: names.tenantName,
        resourceArn: fakeConfigurationSetArn,
      }),
    note: "the ARN is DERIVED from the tenant ARN; a not_found here means the derivation is wrong, not that the set is missing",
  });
  if (associatedSet.ok) {
    cleanup.push(
      `disassociate-configuration-set ${names.configurationSetName}`,
      () =>
        tolerate(() =>
          real.disassociateResource({
            tenantName: names.tenantName,
            resourceArn: realConfigurationSetArn,
          }),
        ),
    );
  }

  // -- createIdentity (BYODKIM, 2048-bit) -----------------------------------
  // The private key crosses the wire here and NOWHERE else. It is redacted out
  // of the recorded input, and `SesError` keeps AWS's response body verbatim,
  // so the runner scrubs the rendered report against it as well.
  const identityInput = {
    domain: names.identityDomain,
    configurationSetName: names.configurationSetName,
    dkim: { selector: keypair.selector, privateKey: keypair.privateKey },
  };
  const identities = await recorder.compare<SesIdentity>({
    verb: "createIdentity",
    input: {
      ...identityInput,
      dkim: { selector: keypair.selector, privateKey: REDACTED },
    },
    real: () => real.createIdentity(identityInput),
    fake: () => fake.createIdentity(identityInput),
    note: "BYODKIM: `dkim.origin` must be EXTERNAL and `dkim.tokens` must be EMPTY, or AWS wants more than the ONE TXT record PRD 07 promises",
  });
  if (identities.real) {
    dkim.awsOrigin = identities.real.dkim.origin;
    dkim.awsStatus = identities.real.dkim.status;
    dkim.awsTokens = [...identities.real.dkim.tokens];
    if (dkim.awsTokens.length > 0) {
      notes.push(
        `AWS returned ${dkim.awsTokens.length} Easy-DKIM token(s) for a BYODKIM identity. PRD 07 claims ONE TXT record; this would make it ${
          1 + dkim.awsTokens.length
        }.`,
      );
    }
    if (identities.real.dkim.origin !== "EXTERNAL") {
      notes.push(
        `AWS reported dkim.origin=${identities.real.dkim.origin} for an identity created with DomainSigningAttributesOrigin=EXTERNAL — the BYODKIM request did not take.`,
      );
    }
  }
  if (identities.ok) {
    cleanup.push(`delete-identity ${names.identityDomain}`, () =>
      tolerate(() => real.deleteIdentity({ identity: names.identityDomain })),
    );
  }

  // -- getIdentity ----------------------------------------------------------
  await recorder.compare({
    verb: "getIdentity",
    input: { identity: names.identityDomain },
    real: () => real.getIdentity({ identity: names.identityDomain }),
    fake: () => fake.getIdentity({ identity: names.identityDomain }),
  });

  // -- setMailFrom ----------------------------------------------------------
  const mailFrom = {
    identity: names.identityDomain,
    mailFromDomain: names.mailFromDomain,
    behaviorOnMxFailure: "USE_DEFAULT_VALUE" as const,
  };
  await recorder.compare({
    verb: "setMailFrom",
    input: mailFrom,
    real: () => real.setMailFrom(mailFrom),
    fake: () => fake.setMailFrom(mailFrom),
    note: "custom MAIL FROM must be a subdomain of the identity's own parent domain (DECISIONS §2)",
  });

  // -- associateResource (identity) -----------------------------------------
  const realIdentityArn = tenantScopedArn(
    realTenant.arn,
    "identity",
    names.identityDomain,
  );
  const fakeIdentityArn = tenantScopedArn(
    fakeTenant.arn,
    "identity",
    names.identityDomain,
  );
  const associatedIdentity = await recorder.compare({
    verb: "associateResource",
    label: "associateResource:identity",
    input: { tenantName: names.tenantName, resourceArn: realIdentityArn },
    real: () =>
      real.associateResource({
        tenantName: names.tenantName,
        resourceArn: realIdentityArn,
      }),
    fake: () =>
      fake.associateResource({
        tenantName: names.tenantName,
        resourceArn: fakeIdentityArn,
      }),
  });
  if (associatedIdentity.ok) {
    cleanup.push(`disassociate-identity ${names.identityDomain}`, () =>
      tolerate(() =>
        real.disassociateResource({
          tenantName: names.tenantName,
          resourceArn: realIdentityArn,
        }),
      ),
    );
  }

  // -- send -----------------------------------------------------------------
  // The run-scoped identity created above can NEVER send: nobody published its
  // DNS, so AWS will never verify it. A send therefore needs an identity the
  // account already holds, associated with this run's tenant for the duration.
  const { sendFrom, sendTo } = options;
  if (sendFrom && sendTo) {
    const senderDomain = domainOfAddress(sendFrom);
    const realSenderArn = tenantScopedArn(
      realTenant.arn,
      "identity",
      senderDomain,
    );
    const fakeSenderArn = tenantScopedArn(
      fakeTenant.arn,
      "identity",
      senderDomain,
    );
    // The one place the Fake is advanced rather than driven: the real account
    // already holds this identity, verified, and `__verifyIdentity` is exactly
    // the affordance for reaching a state AWS reached through DNS.
    await fake.createIdentity({ domain: senderDomain });
    fake.__verifyIdentity(senderDomain);

    const associatedSender = await recorder.compare({
      verb: "associateResource",
      label: "associateResource:sender-identity",
      input: { tenantName: names.tenantName, resourceArn: realSenderArn },
      real: () =>
        real.associateResource({
          tenantName: names.tenantName,
          resourceArn: realSenderArn,
        }),
      fake: () =>
        fake.associateResource({
          tenantName: names.tenantName,
          resourceArn: fakeSenderArn,
        }),
    });
    if (associatedSender.ok) {
      cleanup.push(`disassociate-sender-identity ${senderDomain}`, () =>
        tolerate(() =>
          real.disassociateResource({
            tenantName: names.tenantName,
            resourceArn: realSenderArn,
          }),
        ),
      );
    }

    const message = {
      from: sendFrom,
      to: [sendTo],
      subject: `Hogsend SES walkthrough ${names.runId}`,
      text: `Contract walkthrough ${names.runId}. Nothing to do; this address was named with --send-to.`,
    };
    await recorder.compare({
      verb: "sendEmail",
      input: {
        tenantName: names.tenantName,
        configurationSetName: names.configurationSetName,
        message,
      },
      volatile: ["messageId"],
      real: () =>
        real.sendEmail({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          message,
        }),
      fake: () =>
        fake.sendEmail({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          message,
        }),
      note: "in sandbox the recipient must ALSO be a verified identity; a MessageRejected here is sandbox policy, not a contract divergence",
    });

    const batchMessage = { ...message, subject: `${message.subject} (batch)` };
    await recorder.compare({
      verb: "sendBatch",
      input: {
        tenantName: names.tenantName,
        configurationSetName: names.configurationSetName,
        messages: [batchMessage],
      },
      volatile: ["results.*.messageId"],
      real: () =>
        real.sendBatch({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          messages: [batchMessage],
        }),
      fake: () =>
        fake.sendBatch({
          tenantName: names.tenantName,
          configurationSetName: names.configurationSetName,
          messages: [batchMessage],
        }),
      note: "sendBatch fans out SendEmail rather than calling SendBulkEmail; the shape under test is the PER-ENTRY result, not a bulk response",
    });
  } else {
    const reason =
      "no --send-from/--send-to: a send needs an identity the account has already VERIFIED (the run-scoped identity never can be — nobody publishes its DNS)";
    recorder.skip({ verb: "sendEmail", reason });
    recorder.skip({ verb: "sendBatch", reason });
  }

  // -- reputation -----------------------------------------------------------
  await recorder.compare({
    verb: "setReputationPolicy",
    input: { tenantName: names.tenantName, policy: "NONE" },
    real: () =>
      real.setReputationPolicy({
        tenantName: names.tenantName,
        policy: "NONE",
      }),
    fake: () =>
      fake.setReputationPolicy({
        tenantName: names.tenantName,
        policy: "NONE",
      }),
    note: "the policy travels as an AWS-owned ARN, not the bare word; a validation error here means `reputationPolicyArn` is wrong",
  });

  // BEFORE any customer write: the Fake omits `customerManagedStatus` until
  // one exists, and PRD 08's reconciler branches on that absence. If AWS
  // fabricates a record here, that branch is reading a value that is always
  // present and the reconciler is silently wrong.
  await recorder.compare({
    verb: "getReputationEntity",
    label: "getReputationEntity:before-customer-write",
    input: { tenantName: names.tenantName, tenantArn: realTenant.arn },
    volatile: [
      "reference",
      "customerManagedStatus.lastUpdatedAt",
      "awsSesManagedStatus.lastUpdatedAt",
    ],
    real: () =>
      real.getReputationEntity({
        tenantName: names.tenantName,
        tenantArn: realTenant.arn,
      }),
    fake: () =>
      fake.getReputationEntity({
        tenantName: names.tenantName,
        tenantArn: fakeTenant.arn,
      }),
    note: "`customerManagedStatus` must be ABSENT until a customer write exists — PRD 08 branches on its presence",
  });

  await recorder.compare({
    verb: "setTenantSendingStatus",
    input: { tenantName: names.tenantName, status: "ENABLED" },
    real: () =>
      real.setTenantSendingStatus({
        tenantName: names.tenantName,
        status: "ENABLED",
      }),
    fake: () =>
      fake.setTenantSendingStatus({
        tenantName: names.tenantName,
        status: "ENABLED",
      }),
  });

  await recorder.compare({
    verb: "getReputationEntity",
    label: "getReputationEntity:after-customer-write",
    input: { tenantName: names.tenantName, tenantArn: realTenant.arn },
    volatile: [
      "reference",
      "customerManagedStatus.lastUpdatedAt",
      "awsSesManagedStatus.lastUpdatedAt",
    ],
    real: () =>
      real.getReputationEntity({
        tenantName: names.tenantName,
        tenantArn: realTenant.arn,
      }),
    fake: () =>
      fake.getReputationEntity({
        tenantName: names.tenantName,
        tenantArn: fakeTenant.arn,
      }),
    note: "the customer-managed record must APPEAR now, and `policyArn` should carry the ARN just written",
  });

  // -- listRecommendations --------------------------------------------------
  // Account-wide, so its CONTENT is whatever the account happens to hold. Only
  // the envelope is compared; the answer is kept verbatim for a human.
  const recommendations = await recorder.compare({
    verb: "listRecommendations",
    input: {},
    volatile: ["recommendations", "nextToken"],
    real: () => real.listRecommendations({}),
    fake: () => fake.listRecommendations({}),
    note: "account-scoped: only the envelope is compared, because the real account's recommendations are not the Fake's to know",
  });
  if (recommendations.real) {
    notes.push(
      `listRecommendations returned ${recommendations.real.recommendations.length} recommendation(s) for the account`,
    );
  }

  // -- teardown, through the recorder ---------------------------------------
  // The destructive verbs are COMPARED rather than left to the cleanup stack,
  // because their answers are as much a part of the contract as the creates —
  // `deleteTenant` on a missing tenant is `not_found` on both implementations,
  // and a teardown that branches on that (`services/ses-tenants.ts` does) is
  // relying on it. The cleanup stack still holds every one of them and
  // tolerates `not_found`, so this is a fast path, never the only path.
  await recorder.compare({
    verb: "disassociateResource",
    label: "disassociateResource:identity",
    input: { tenantName: names.tenantName, resourceArn: realIdentityArn },
    real: () =>
      real.disassociateResource({
        tenantName: names.tenantName,
        resourceArn: realIdentityArn,
      }),
    fake: () =>
      fake.disassociateResource({
        tenantName: names.tenantName,
        resourceArn: fakeIdentityArn,
      }),
  });

  await recorder.compare({
    verb: "deleteIdentity",
    input: { identity: names.identityDomain },
    real: () => real.deleteIdentity({ identity: names.identityDomain }),
    fake: () => fake.deleteIdentity({ identity: names.identityDomain }),
  });

  await recorder.compare({
    verb: "disassociateResource",
    label: "disassociateResource:configuration-set",
    input: {
      tenantName: names.tenantName,
      resourceArn: realConfigurationSetArn,
    },
    real: () =>
      real.disassociateResource({
        tenantName: names.tenantName,
        resourceArn: realConfigurationSetArn,
      }),
    fake: () =>
      fake.disassociateResource({
        tenantName: names.tenantName,
        resourceArn: fakeConfigurationSetArn,
      }),
  });

  await recorder.compare({
    verb: "deleteTenant",
    input: { tenantName: names.tenantName },
    real: () => real.deleteTenant({ tenantName: names.tenantName }),
    fake: () => fake.deleteTenant({ tenantName: names.tenantName }),
  });

  await recorder.compare({
    verb: "deleteConfigurationSet",
    input: { configurationSetName: names.configurationSetName },
    real: () =>
      real.deleteConfigurationSet({
        configurationSetName: names.configurationSetName,
      }),
    fake: () =>
      fake.deleteConfigurationSet({
        configurationSetName: names.configurationSetName,
      }),
    note: "deleted AFTER the tenant, matching SES_DEPROVISION_STEPS; the cleanup stack's reverse order would do it before, and that difference is itself worth watching",
  });

  return finish();
}

/**
 * Swallow exactly `not_found`, which is a teardown's goal rather than an error.
 * Everything else propagates so the cleanup report names it.
 */
async function tolerate(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SesError && error.kind === "not_found") return;
    throw error;
  }
}
