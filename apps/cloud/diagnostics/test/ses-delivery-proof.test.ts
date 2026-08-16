import { eq, inArray, like } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  sesBounceNotification,
  sesComplaintNotification,
  sesDeliveryNotification,
  tagForEnvironment,
} from "../../src/__tests__/helpers/ses-notifications";
import { db, sqlClient } from "../../src/db";
import { runCloudMigrations } from "../../src/db/migrator";
import { emailEvents, organizations, sesTenants } from "../../src/db/schema";
import { env } from "../../src/env";
import { normalizeSesNotification } from "../../src/lib/ses-events";
import { ingestSesEvent } from "../../src/services/email-events";
import { AWS_SES_ID } from "../../src/ses/aws";
import type { SesClient } from "../../src/ses/contract";
import { FakeSesClient, type FakeSesSentMessage } from "../../src/ses/fake";
import { SesError } from "../../src/ses/types";
import type { SubstrateRegion } from "../../src/substrate/types";
import type {
  DeliveryProofDeps,
  DeliveryProofReport,
  ProofNames,
  ProofSnsClient,
} from "../src/ses-delivery-proof";
import {
  executeProof,
  observeEmailEvents,
  PROOF_CONFIRMATION_FLAG,
  PROOF_LINK_IDS,
  parseProofArgs,
  proofNames,
  renderProofReport,
  requireSimulatorRecipient,
  runDeliveryProof,
  SIMULATOR_DOMAIN,
  simulatorRecipient,
} from "../src/ses-delivery-proof";
import type { TenantCensus } from "../src/ses-walkthrough";
import {
  ACCESS_KEY_VAR,
  isWalkthroughTenantName,
  SECRET_KEY_VAR,
  WalkthroughRefusal,
} from "../src/ses-walkthrough";

/**
 * The SES delivery proof (PRD 19 tasks 3–4), provable with no AWS account.
 *
 * Same split as `ses-walkthrough.test.ts`: the script is deliberately NOT a
 * vitest file — it needs real credentials, a live tunnel and a running control
 * plane — so what IS tested offline is everything that decides whether it may
 * touch AWS, plus the whole chain against `FakeSesClient`, a fake SNS wire, the
 * REAL test database and the REAL run-scoped stub instance (loopback only;
 * nothing leaves the machine).
 */

const PUBLIC_URL = "https://proof-test.trycloudflare.com";
const SEND_FROM = "ses-proof@hogsend.com";
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-ses-events";
const CREDS = { [ACCESS_KEY_VAR]: "AKIA", [SECRET_KEY_VAR]: "s3cret" };
const WEBHOOK_SECRET = "proof-test-webhook-secret-0123456789abcdef";

/** One distinct run id per test, so a crashed run cannot poison the next. */
let runSeq = 0;
function nextRunId(): string {
  runSeq += 1;
  return `20260811-1200${String(runSeq).padStart(2, "0")}-abc123`;
}

function baseArgs(extra: string[] = []): string[] {
  return [
    PROOF_CONFIRMATION_FLAG,
    "--public-url",
    PUBLIC_URL,
    "--send-from",
    SEND_FROM,
    "--sns-topic-arn",
    TOPIC_ARN,
    ...extra,
  ];
}

/** A Fake standing in for AWS, already holding the verified sender domain. */
function seededFake(): FakeSesClient {
  const fake = new FakeSesClient({ region: "us" });
  void fake.createIdentity({ domain: "hogsend.com" });
  fake.__verifyIdentity("hogsend.com");
  return fake;
}

interface FakeSns {
  client: ProofSnsClient;
  subscribed: { topicArn: string; endpoint: string }[];
  unsubscribed: string[];
}

function fakeSns(
  opts: { confirmAfterPolls?: number; neverConfirm?: boolean } = {},
): FakeSns {
  const subscribed: { topicArn: string; endpoint: string }[] = [];
  const unsubscribed: string[] = [];
  let polls = 0;
  const client: ProofSnsClient = {
    async subscribe(input) {
      subscribed.push(input);
    },
    async findSubscription(input) {
      if (subscribed.length === 0) return { status: "absent" };
      if (opts.neverConfirm) return { status: "pending" };
      polls += 1;
      return polls >= (opts.confirmAfterPolls ?? 2)
        ? { status: "confirmed", subscriptionArn: `${input.topicArn}:sub-1` }
        : { status: "pending" };
    },
    async unsubscribe(input) {
      unsubscribed.push(input.subscriptionArn);
    },
  };
  return { client, subscribed, unsubscribed };
}

/**
 * Play the part of SES + SNS + the control-plane ingress for the given sent
 * messages: normalize an AWS-verbatim fixture carrying the sent message id and
 * the run's tenant tag, then hand it to the REAL `ingestSesEvent` with the
 * REAL database — whose tenant resolution reads the rows the proof script
 * itself registered, and whose signed instance hop POSTs (default fetch,
 * loopback) to the proof's own stub instance.
 *
 * Safe to replay on every poll: the dedupe key collapses an already-ingested
 * send into a `duplicate` outcome without touching the stub again, so callers
 * can hand it `real.__sent()` each time the proof sleeps and the probe's
 * mid-observation send still gets its bounce ingested exactly once.
 */
async function playAwsPipeline(
  sends: FakeSesSentMessage[],
  names: ProofNames,
): Promise<void> {
  for (const sent of sends) {
    const to = sent.message.to[0] ?? "";
    const fixture = to.startsWith("success+")
      ? sesDeliveryNotification()
      : to.startsWith("bounce+")
        ? sesBounceNotification()
        : sesComplaintNotification();
    const tagged = tagForEnvironment(fixture, names.environmentId);
    const mail = tagged.mail as Record<string, unknown>;
    tagged.mail = { ...mail, messageId: sent.messageId, destination: [to] };
    const normalized = normalizeSesNotification(tagged);
    if (!normalized) throw new Error(`fixture for ${to} did not normalize`);
    await ingestSesEvent({ region: "us", normalized }, { db });
  }
}

async function cleanupRunRows(): Promise<void> {
  // Fake message ids restart at 1 per instance, so rows a crashed test left
  // behind would collide with the next run's dedupe keys.
  await db
    .delete(emailEvents)
    .where(like(emailEvents.messageId, "fake-ses-message-%"));
  await db
    .delete(emailEvents)
    .where(like(emailEvents.tenantName, "env-ses-walkthrough-proof-%"));
  await db
    .delete(organizations)
    .where(like(organizations.id, "ses-walkthrough-proof-%"));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanupRunRows();
});

afterAll(async () => {
  await cleanupRunRows();
  await sqlClient.end();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanupRunRows();
});

// ---------------------------------------------------------------------------
// Argument parsing and pure guards
// ---------------------------------------------------------------------------

describe("proof guards — parsing", () => {
  it("refuses an unknown argument rather than ignoring it", () => {
    expect(() => parseProofArgs(baseArgs(["--yolo"]))).toThrow(
      WalkthroughRefusal,
    );
  });

  it("refuses --send-to outright, naming the simulator", () => {
    let thrown: unknown;
    try {
      parseProofArgs(baseArgs(["--send-to", "doug@example.com"]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalkthroughRefusal);
    expect((thrown as Error).message).toContain(SIMULATOR_DOMAIN);
  });

  it("refuses an unmapped region", () => {
    expect(() => parseProofArgs(baseArgs(["--region", "ap-south-1"]))).toThrow(
      WalkthroughRefusal,
    );
  });

  it("refuses a non-positive --observe-seconds", () => {
    expect(() => parseProofArgs(baseArgs(["--observe-seconds", "0"]))).toThrow(
      WalkthroughRefusal,
    );
    expect(() =>
      parseProofArgs(baseArgs(["--observe-seconds", "abc"])),
    ).toThrow(WalkthroughRefusal);
  });

  it("skips the pnpm `--` separator instead of refusing the documented command", () => {
    // `pnpm --filter @hogsend/cloud ses:delivery-proof -- --i-know…` forwards
    // the literal `--` into argv; it is a separator, not a typo.
    const parsed = parseProofArgs(["--", ...baseArgs()]);
    expect(parsed.confirmed).toBe(true);
  });

  it("parses the full happy invocation", () => {
    const parsed = parseProofArgs(baseArgs(["--region", "us", "--json"]));
    expect(parsed).toMatchObject({
      confirmed: true,
      publicUrl: PUBLIC_URL,
      sendFrom: SEND_FROM,
      snsTopicArn: TOPIC_ARN,
      region: "us",
      json: true,
    });
  });
});

describe("proof guards — the simulator-only rule", () => {
  it("accepts a labelled simulator address, case-insensitively", () => {
    expect(() =>
      requireSimulatorRecipient("bounce+run-1@simulator.amazonses.com"),
    ).not.toThrow();
    expect(() =>
      requireSimulatorRecipient("Success+X@SIMULATOR.AMAZONSES.COM"),
    ).not.toThrow();
  });

  it("refuses a real inbox", () => {
    let thrown: unknown;
    try {
      requireSimulatorRecipient("doug@gmail.com");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalkthroughRefusal);
    expect((thrown as Error).message).toContain(SIMULATOR_DOMAIN);
  });

  it("refuses a lookalike domain", () => {
    expect(() =>
      requireSimulatorRecipient("bounce@simulator.amazonses.com.evil.com"),
    ).toThrow(WalkthroughRefusal);
  });

  it("derives labelled scenario addresses", () => {
    expect(simulatorRecipient("success", "run-1")).toBe(
      "success+run-1@simulator.amazonses.com",
    );
    expect(simulatorRecipient("bounce", "run-1")).toBe(
      "bounce+run-1@simulator.amazonses.com",
    );
    expect(simulatorRecipient("complaint", "run-1")).toBe(
      "complaint+run-1@simulator.amazonses.com",
    );
  });
});

describe("proof naming", () => {
  it("mints tenants the walkthrough sweeper recognises", () => {
    const names = proofNames("20260811-120000-a1b2c3");
    expect(isWalkthroughTenantName(names.tenantName)).toBe(true);
    expect(names.tenantName.length).toBeLessThanOrEqual(64);
    expect(names.tenantName).toMatch(/^[a-z0-9-]+$/);
    expect(names.configurationSetName).toBe(names.tenantName);
  });
});

// ---------------------------------------------------------------------------
// Runner refusals — nothing may reach AWS before every guard has passed
// ---------------------------------------------------------------------------

describe("runDeliveryProof refusals", () => {
  let resolveClient: Mock<(region: SubstrateRegion) => SesClient>;
  let census: Mock<TenantCensus>;
  let fetchImpl: Mock<typeof fetch>;
  const lines: string[] = [];

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      env: CREDS,
      resolveClient,
      census: () => census,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      out: (line: string) => lines.push(line),
      ...overrides,
    };
  }

  beforeEach(() => {
    lines.length = 0;
    resolveClient = vi.fn();
    census = vi.fn(async () => []);
    fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
  });

  it("refuses without the confirmation flag and calls nothing", async () => {
    const result = await runDeliveryProof(
      baseArgs().filter((arg) => arg !== PROOF_CONFIRMATION_FLAG),
      deps(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("not_confirmed");
    expect(resolveClient).not.toHaveBeenCalled();
    expect(census).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses with one credential missing, naming both", async () => {
    const result = await runDeliveryProof(baseArgs(), {
      ...deps(),
      env: { [ACCESS_KEY_VAR]: "AKIA" },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("no_credentials");
    const printed = lines.join("\n");
    expect(printed).toContain(ACCESS_KEY_VAR);
    expect(printed).toContain(SECRET_KEY_VAR);
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it("refuses a missing --public-url", async () => {
    const argv = baseArgs().filter(
      (arg, index, all) =>
        arg !== "--public-url" && all[index - 1] !== "--public-url",
    );
    const result = await runDeliveryProof(argv, deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("bad_public_url");
  });

  it("refuses a non-https --public-url", async () => {
    const argv = baseArgs().map((arg) =>
      arg === PUBLIC_URL ? "http://localhost:3004" : arg,
    );
    const result = await runDeliveryProof(argv, deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("bad_public_url");
    expect(lines.join("\n")).toContain("https");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a missing --send-from", async () => {
    const argv = baseArgs().filter(
      (arg, index, all) =>
        arg !== "--send-from" && all[index - 1] !== "--send-from",
    );
    const result = await runDeliveryProof(argv, deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("no_sender");
  });

  it("refuses when no SNS topic is configured anywhere, fail-closed", async () => {
    const argv = baseArgs().filter(
      (arg, index, all) =>
        arg !== "--sns-topic-arn" && all[index - 1] !== "--sns-topic-arn",
    );
    const result = await runDeliveryProof(argv, deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("no_topic");
    expect(lines.join("\n")).toContain("CLOUD_SES_SNS_TOPIC_ARN_US");
  });

  it("reads the region's topic from the env when the flag is omitted", async () => {
    const argv = baseArgs().filter(
      (arg, index, all) =>
        arg !== "--sns-topic-arn" && all[index - 1] !== "--sns-topic-arn",
    );
    // The tunnel is down, so the run still refuses — but PAST the topic guard.
    fetchImpl.mockResolvedValue(new Response("no", { status: 502 }));
    const result = await runDeliveryProof(argv, {
      ...deps(),
      env: { ...CREDS, CLOUD_SES_SNS_TOPIC_ARN_US: TOPIC_ARN },
    });
    expect(result.refusal?.code).toBe("tunnel_down");
  });

  it("refuses when the tunnel health check does not answer 200", async () => {
    fetchImpl.mockResolvedValue(new Response("no", { status: 502 }));
    const result = await runDeliveryProof(baseArgs(), deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("tunnel_down");
    // The most likely operator error refuses BEFORE the first AWS call.
    expect(census).not.toHaveBeenCalled();
    expect(resolveClient).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PUBLIC_URL}/api/health`,
      expect.anything(),
    );
  });

  it("refuses when the tunnel is unreachable at all", async () => {
    fetchImpl.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const result = await runDeliveryProof(baseArgs(), deps());
    expect(result.refusal?.code).toBe("tunnel_down");
    expect(census).not.toHaveBeenCalled();
  });

  it("refuses a tenant-bearing account before resolving a client", async () => {
    census.mockResolvedValue(["env-a-real-customer"]);
    const result = await runDeliveryProof(baseArgs(), deps());
    expect(result.exitCode).not.toBe(0);
    expect(result.refusal?.code).toBe("account_not_empty");
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it("refuses when the resolved client is not the AWS one", async () => {
    const result = await runDeliveryProof(baseArgs(), {
      ...deps(),
      resolveClient: () => new FakeSesClient({ region: "us" }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(lines.join("\n")).toMatch(/fake/i);
  });

  it("prints usage and exits 0 on --help", async () => {
    const result = await runDeliveryProof(["--help"], deps());
    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain(PROOF_CONFIRMATION_FLAG);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The chain, against the Fake + the real database + the real stub instance
// ---------------------------------------------------------------------------

interface ExecuteOverrides {
  real?: FakeSesClient;
  sns?: FakeSns;
  recipients?: Partial<Record<"success" | "bounce" | "complaint", string>>;
  sleep?: (ms: number) => Promise<void>;
  observeSeconds?: number;
  subscribeWaitSeconds?: number;
}

async function runExecute(overrides: ExecuteOverrides = {}) {
  const runId = nextRunId();
  const names = proofNames(runId);
  const real = overrides.real ?? seededFake();
  const sns = overrides.sns ?? fakeSns();

  const sleep =
    overrides.sleep ??
    (async () => {
      // The moment SES, SNS and the control-plane ingress would act: once the
      // sends exist, drive each through the REAL ingest. Replayed on every
      // poll (rather than gated to run once) because the suppression probe's
      // send appears MID-observation — its bounce must be ingested too, and
      // the dedupe key makes the replay idempotent for everything earlier.
      if (real.__sent().length >= 3) {
        await playAwsPipeline(real.__sent(), names);
      }
    });

  const result = await executeProof({
    client: real,
    sns: sns.client,
    db,
    names,
    region: "us",
    sendFrom: SEND_FROM,
    publicUrl: PUBLIC_URL,
    topicArn: TOPIC_ARN,
    webhookSecret: WEBHOOK_SECRET,
    observeSeconds: overrides.observeSeconds ?? 10,
    subscribeWaitSeconds: overrides.subscribeWaitSeconds ?? 10,
    sleep,
    out: () => {},
    ...(overrides.recipients ? { recipients: overrides.recipients } : {}),
  });

  return { result, names, real, sns };
}

function linkById(result: { links: { id: string; status: string }[] }) {
  return new Map(result.links.map((link) => [link.id, link.status]));
}

describe("executeProof — the happy chain", () => {
  it("proves every link and reports them all by name", async () => {
    const { result, names, real, sns } = await runExecute();

    expect(result.aborted).toBeUndefined();
    expect(result.findings).toEqual([]);

    // Every expected event arrived, normalized to the right type, and was
    // DELIVERED over the signed hop to the run-scoped stub instance.
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.arrived).toBe(true);
      expect(event.typeMatches).toBe(true);
      expect(event.status).toBe("delivered");
    }
    expect(result.events.map((event) => event.expectedType).sort()).toEqual([
      "email.bounced",
      "email.complained",
      "email.delivered",
    ]);

    // The stub saw all FOUR deliveries — the three scenarios plus the
    // suppression probe's own bounce, which the proof now waits for and
    // judges by subtype — every signature valid.
    expect(result.stub.received).toBe(4);
    expect(result.stub.signatureFailures).toBe(0);

    // The report accounts for EVERY link — a bare pass is a failure.
    const ids = result.links.map((link) => link.id);
    expect(ids).toEqual(PROOF_LINK_IDS.filter((id) => id !== "tunnel_health"));
    const statuses = linkById(result);
    expect(statuses.get("sender_verified")).toBe("exercised");
    expect(statuses.get("provision")).toBe("exercised");
    expect(statuses.get("put_event_destination")).toBe("exercised");
    expect(statuses.get("sns_subscription")).toBe("exercised");
    expect(statuses.get("send_email")).toBe("exercised");
    expect(statuses.get("send_batch")).toBe("exercised");
    expect(statuses.get("event_delivered")).toBe("exercised");
    expect(statuses.get("event_bounced")).toBe("exercised");
    expect(statuses.get("event_complained")).toBe("exercised");
    expect(statuses.get("instance_hop")).toBe("exercised");
    // Honest, by design: the stub is not an engine instance.
    expect(statuses.get("engine_terminal_status")).toBe("not_exercised");
    expect(statuses.get("reject_leg")).toBe("not_exercised");

    // The suppression verdict came from the probe's OWN bounce event — a
    // suppressed send is ACCEPTED by SES, so acceptance can never be the
    // evidence. The detail names the simulator's normal `General` subtype.
    expect(result.probeMessageId).toBeDefined();
    const suppression = result.links.find(
      (link) => link.id === "suppression_check",
    );
    expect(suppression?.status).toBe("exercised");
    expect(suppression?.detail).toContain("General");

    // The subscription named the region's ingress endpoint, and was removed.
    expect(sns.subscribed).toEqual([
      { topicArn: TOPIC_ARN, endpoint: `${PUBLIC_URL}/api/email/events/us` },
    ]);
    expect(sns.unsubscribed).toHaveLength(1);

    // Teardown left the account and the database as it found them.
    expect(real.__tenant(names.tenantName)).toBeUndefined();
    expect(real.__configurationSet(names.configurationSetName)).toBeUndefined();
    expect(result.cleanup.failed).toEqual([]);
    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, names.organizationId));
    expect(orgs).toEqual([]);
    // The run's event rows went with the environment (cascade) — the report
    // is the record, not the table.
    const rows = await db
      .select()
      .from(emailEvents)
      .where(
        inArray(
          emailEvents.messageId,
          result.events.map((event) => event.messageId),
        ),
      );
    expect(rows).toEqual([]);
  });

  it("exercises sendBatch as well as sendEmail", async () => {
    const { real } = await runExecute();
    const methods = real.calls.map((call) => call.method);
    expect(methods).toContain("sendEmail");
    expect(methods).toContain("sendBatch");
    expect(methods).toContain("putEventDestination");
  });
});

describe("executeProof — refusals that create nothing", () => {
  it("refuses an unverified sender, naming the unclicked email", async () => {
    const real = new FakeSesClient({ region: "us" });
    void real.createIdentity({ domain: "hogsend.com" });
    // NOT verified: the operator never clicked the verification email.
    const { result } = await runExecute({ real });
    expect(result.aborted).toMatch(/verif/i);
    expect(result.aborted).toMatch(/unclicked|not.*clicked|click/i);
    expect(real.__tenants()).toEqual([]);
    expect(linkById(result).get("sender_verified")).toBe("failed");
  });

  it("refuses a sender the account does not hold at all", async () => {
    const real = new FakeSesClient({ region: "us" });
    const { result } = await runExecute({ real });
    expect(result.aborted).toMatch(/verif/i);
    expect(real.__tenants()).toEqual([]);
  });

  it("refuses a non-simulator recipient before creating ANYTHING", async () => {
    const real = seededFake();
    const { result } = await runExecute({
      real,
      recipients: { bounce: "doug@gmail.com" },
    });
    expect(result.aborted).toContain(SIMULATOR_DOMAIN);
    expect(real.__tenants()).toEqual([]);
    expect(real.__sent()).toEqual([]);
    expect(result.cleanup.order).toEqual([]);
  });
});

describe("executeProof — teardown on mid-run failure", () => {
  it("tears down AWS resources when putEventDestination fails", async () => {
    const real = seededFake();
    real.failNext(
      "putEventDestination",
      new SesError("denied", {
        kind: "invalid",
        operation: "putEventDestination",
      }),
    );
    const { result, names } = await runExecute({ real });

    expect(result.aborted).toMatch(/putEventDestination/);
    expect(linkById(result).get("put_event_destination")).toBe("failed");
    expect(real.__tenant(names.tenantName)).toBeUndefined();
    expect(real.__configurationSet(names.configurationSetName)).toBeUndefined();
    expect(result.cleanup.failed).toEqual([]);
    // Never reached, and the report says so rather than passing over it.
    expect(linkById(result).get("send_email")).toBe("not_exercised");
  });

  it("tears down the stub, the db rows and AWS when confirmation never comes", async () => {
    const real = seededFake();
    const sns = fakeSns({ neverConfirm: true });
    const { result, names } = await runExecute({
      real,
      sns,
      subscribeWaitSeconds: 1,
    });

    expect(result.aborted).toMatch(/confirm/i);
    expect(real.__tenant(names.tenantName)).toBeUndefined();
    expect(result.cleanup.order.join("\n")).toMatch(/stub/);
    expect(result.cleanup.order.join("\n")).toMatch(/unregister/);
    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, names.organizationId));
    expect(orgs).toEqual([]);
    expect(result.cleanup.failed).toEqual([]);
  });

  it("reports a teardown failure instead of swallowing it", async () => {
    const real = seededFake();
    real.failNext("putEventDestination", new SesError("denied"));
    // The tenant refuses to die: the cleanup stack must record it and keep
    // tearing everything else down.
    real.failNext(
      "deleteTenant",
      new SesError("stuck", { kind: "transient", operation: "deleteTenant" }),
    );
    const { result } = await runExecute({ real });
    expect(result.cleanup.failed).toHaveLength(1);
    expect(result.cleanup.failed[0]?.label).toMatch(/tenant/);
  });
});

describe("executeProof — the suppression probe judges by bounce subtype", () => {
  /** The executeProof input every probe test shares; only `sleep` varies. */
  function probeInput(
    real: FakeSesClient,
    names: ProofNames,
    sleep: (ms: number) => Promise<void>,
  ) {
    return {
      client: real,
      sns: fakeSns().client,
      db,
      names,
      region: "us" as const,
      sendFrom: SEND_FROM,
      publicUrl: PUBLIC_URL,
      topicArn: TOPIC_ARN,
      webhookSecret: WEBHOOK_SECRET,
      observeSeconds: 10,
      subscribeWaitSeconds: 10,
      out: () => {},
      sleep,
    };
  }

  /**
   * Ingest the probe's bounce the way REAL SES reports a suppressed send:
   * the send was ACCEPTED ("SES accepts the message, but doesn't send it"),
   * and the only evidence is a Bounce event whose subtype names the list.
   */
  async function ingestProbeBounce(
    probe: FakeSesSentMessage,
    names: ProofNames,
    bounceSubType: string,
  ): Promise<void> {
    const fixture = sesBounceNotification();
    (fixture.bounce as Record<string, unknown>).bounceSubType = bounceSubType;
    const tagged = tagForEnvironment(fixture, names.environmentId);
    const mail = tagged.mail as Record<string, unknown>;
    tagged.mail = {
      ...mail,
      messageId: probe.messageId,
      destination: [probe.message.to[0]],
    };
    const normalized = normalizeSesNotification(tagged);
    if (!normalized) throw new Error("the probe fixture did not normalize");
    await ingestSesEvent({ region: "us", normalized }, { db });
  }

  it("reports the FINDING when the ACCEPTED probe bounces OnAccountSuppressionList", async () => {
    const real = seededFake();
    const names = proofNames(nextRunId());
    const result = await executeProof(
      probeInput(real, names, async () => {
        const sent = real.__sent();
        if (sent.length < 3) return;
        // The three scenario sends travel the normal pipeline...
        await playAwsPipeline(sent.slice(0, 3), names);
        // ...and the probe — REAL SES never throws for a suppressed address,
        // it accepts and bounces with a suppression-named subtype.
        const probe = sent[3];
        if (probe) {
          await ingestProbeBounce(probe, names, "OnAccountSuppressionList");
        }
      }),
    );

    // The send step SUCCEEDED — acceptance is exactly what suppression looks
    // like on the send wire — while the link failed and the finding shouts.
    expect(
      result.steps.find((step) => step.label === "suppression probe re-send")
        ?.status,
    ).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatch(/suppress/i);
    expect(result.findings[0]).toContain("OnAccountSuppressionList");
    expect(linkById(result).get("suppression_check")).toBe("failed");
    // A finding is a FINDING, not an abort: the run still completed and the
    // report still accounts for every link.
    expect(result.aborted).toBeUndefined();
  });

  it("classifies a throttled probe send as a failed step, NOT as suppression", async () => {
    const real = seededFake();
    const names = proofNames(nextRunId());
    let armed = false;
    const result = await executeProof(
      probeInput(real, names, async () => {
        if (real.__sent().length < 3) return;
        await playAwsPipeline(real.__sent(), names);
        if (!armed) {
          armed = true;
          // The PRD-warned case: the 4th send of a burst trips the young
          // account's quota. Suppression logic never ran, so blaming it
          // would be a false report.
          real.failNext(
            "sendEmail",
            new SesError("Too many requests", {
              kind: "transient",
              operation: "sendEmail",
            }),
          );
        }
      }),
    );

    expect(result.findings).toEqual([]);
    expect(linkById(result).get("suppression_check")).toBe("failed");
    expect(
      result.steps.find((step) => step.label === "suppression probe re-send")
        ?.status,
    ).toBe("failed");
    expect(result.aborted).toBeUndefined();
  });

  it("still reports a suppression-SHAPED send refusal as the finding", async () => {
    const real = seededFake();
    const names = proofNames(nextRunId());
    let armed = false;
    const result = await executeProof(
      probeInput(real, names, async () => {
        if (real.__sent().length < 3) return;
        await playAwsPipeline(real.__sent(), names);
        if (!armed) {
          armed = true;
          real.failNext(
            "sendEmail",
            new SesError("recipient is on the suppression list", {
              kind: "invalid",
              operation: "sendEmail",
            }),
          );
        }
      }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatch(/suppress/i);
    expect(linkById(result).get("suppression_check")).toBe("failed");
    expect(result.aborted).toBeUndefined();
  });
});

describe("executeProof — the run-scoped rows never strand", () => {
  it("sweeps the organization when registration fails partway through", async () => {
    const real = seededFake();
    const names = proofNames(nextRunId());
    // A db whose sesTenants insert fails — the LAST of registration's four
    // sequential non-transactional writes, so the organization, environment
    // and stack rows already exist in the REAL control-plane db when it
    // throws. Everything else (the deletes the cleanup runs, the selects)
    // passes straight through to the real db via the prototype chain.
    const failingDb = Object.create(db) as typeof db;
    failingDb.insert = ((table: unknown) => {
      if (table === sesTenants) {
        throw new Error("scripted failure: the sesTenants insert died");
      }
      return db.insert(table as never);
    }) as typeof db.insert;

    const result = await executeProof({
      client: real,
      sns: fakeSns().client,
      db: failingDb,
      names,
      region: "us",
      sendFrom: SEND_FROM,
      publicUrl: PUBLIC_URL,
      topicArn: TOPIC_ARN,
      webhookSecret: WEBHOOK_SECRET,
      observeSeconds: 10,
      subscribeWaitSeconds: 10,
      out: () => {},
      sleep: async () => {},
    });

    expect(result.aborted).toMatch(/register run-scoped stack rows/);
    expect(result.cleanup.order.join("\n")).toMatch(/unregister/);
    // The partial rows are GONE: the unregister step was registered before
    // the inserts ran, and the org delete cascades whatever subset existed.
    const orgs = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, names.organizationId));
    expect(orgs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The runner end to end: the exit code is the single gate against a false pass
// ---------------------------------------------------------------------------

/**
 * The Fake wearing the AWS id, so the REAL runner can be driven end to end:
 * `runDeliveryProof` (correctly) refuses any client that is not "aws", and
 * these tests exist to prove the runner's own exit-code mapping and scrub —
 * which no executeProof-level test can reach.
 */
function awsLookalike(): FakeSesClient {
  const fake = seededFake();
  Object.defineProperty(fake, "id", { value: AWS_SES_ID });
  return fake;
}

function e2eDeps(
  real: FakeSesClient,
  overrides: Partial<DeliveryProofDeps> = {},
): DeliveryProofDeps {
  return {
    env: CREDS,
    resolveClient: () => real,
    census: () => async () => [],
    snsFactory: () => fakeSns().client,
    db,
    fetchImpl: (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch,
    // Bounded so a deadline poll spins on a short timer, not a hot loop.
    sleep: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 25))),
    webhookSecret: WEBHOOK_SECRET,
    out: () => {},
    ...overrides,
  };
}

describe("runDeliveryProof — the exit code is the gate", () => {
  it("exits non-zero when a link fails (the events never arrive)", async () => {
    const real = awsLookalike();
    // Nothing plays the AWS pipeline, so no event ever reaches email_events:
    // every event link fails, and the probe's bounce never arrives either.
    const result = await runDeliveryProof(
      baseArgs(["--run-id", nextRunId(), "--observe-seconds", "1"]),
      e2eDeps(real),
    );

    expect(result.refusal).toBeUndefined();
    expect(result.report?.links.some((link) => link.status === "failed")).toBe(
      true,
    );
    // The probe was ACCEPTED but unproven — acceptance alone must never
    // report "not suppressed".
    expect(
      result.report?.links.find((link) => link.id === "suppression_check")
        ?.status,
    ).toBe("failed");
    expect(result.exitCode).toBe(1);
  });

  it("exits 0 when every link proves out end to end", async () => {
    const runId = nextRunId();
    const names = proofNames(runId);
    const real = awsLookalike();
    const result = await runDeliveryProof(
      baseArgs(["--run-id", runId, "--observe-seconds", "10"]),
      e2eDeps(real, {
        sleep: async () => {
          if (real.__sent().length >= 3) {
            await playAwsPipeline(real.__sent(), names);
          }
        },
      }),
    );

    expect(result.report?.aborted).toBeUndefined();
    expect(result.report?.findings).toEqual([]);
    expect(result.report?.cleanup.failed).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("scrubs the webhook secret out of an error a step quoted verbatim", async () => {
    const real = awsLookalike();
    const lines: string[] = [];
    const failingSns: ProofSnsClient = {
      async subscribe() {
        // Play an SNS error whose body echoed the request verbatim — the
        // exact path the scrub exists for: the secret riding an error
        // message into steps, link details and the abort line.
        throw new Error(
          `InvalidParameter: request rejected (saw secret ${WEBHOOK_SECRET})`,
        );
      },
      async findSubscription() {
        return { status: "absent" as const };
      },
      async unsubscribe() {},
    };
    const result = await runDeliveryProof(
      baseArgs(["--run-id", nextRunId(), "--observe-seconds", "1", "--json"]),
      e2eDeps(real, {
        snsFactory: () => failingSns,
        out: (line) => lines.push(line),
      }),
    );

    const printed = lines.join("\n");
    expect(printed).toContain("<redacted>");
    expect(printed).not.toContain(WEBHOOK_SECRET);
    expect(result.exitCode).toBe(1);
  });
});

describe("the stub instance", () => {
  it("verifies the relay signature with the plugin's own scheme, 401s a bad one", async () => {
    const { startStubInstance } = await import(
      "../src/ses-delivery-proof/stub-instance"
    );
    const { signHogsendRelayWebhook, HOGSEND_RELAY_SIGNATURE_HEADER } =
      await import("@hogsend/plugin-hogsend");
    const stub = await startStubInstance({ secret: WEBHOOK_SECRET });
    try {
      const payload = JSON.stringify({
        type: "email.bounced",
        messageId: "m-1",
      });
      const url = `${stub.url}/v1/webhooks/email/hogsend`;

      const good = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HOGSEND_RELAY_SIGNATURE_HEADER]: signHogsendRelayWebhook({
            payload,
            secret: WEBHOOK_SECRET,
          }),
        },
        body: payload,
      });
      expect(good.status).toBe(200);

      // The mismatched-secret case — exactly what a wrong
      // CLOUD_ENCRYPTION_SECRET produces live. Refused AND recorded.
      const bad = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HOGSEND_RELAY_SIGNATURE_HEADER]: signHogsendRelayWebhook({
            payload,
            secret: "some-other-secret-entirely-0123456789",
          }),
        },
        body: payload,
      });
      expect(bad.status).toBe(401);

      expect(stub.received).toEqual([
        { signatureValid: true, type: "email.bounced", messageId: "m-1" },
        { signatureValid: false, type: null, messageId: null },
      ]);
    } finally {
      await stub.close();
    }
  });
});

describe("observeEmailEvents — the deadline", () => {
  it("reports a never-arriving event as such instead of waiting forever", async () => {
    // Insert ONE of the two expected rows directly, playing an ingress that
    // only ever saw the delivery.
    const arrivedId = `fake-ses-message-observe-${Date.now()}`;
    const missingId = `${arrivedId}-missing`;
    await db.insert(emailEvents).values({
      tenantName: "env-ses-walkthrough-proof-observe",
      region: "us",
      dedupeKey: `observe-${arrivedId}`,
      type: "email.delivered",
      messageId: arrivedId,
      payload: {},
      status: "delivered",
      occurredAt: new Date(),
    });

    // A virtual clock: each poll "costs" a second, so the 5s deadline passes
    // without the test actually waiting.
    let clock = 0;
    const observed = await observeEmailEvents({
      db,
      expected: [
        {
          scenario: "success",
          recipient: "success+x@simulator.amazonses.com",
          messageId: arrivedId,
          expectedType: "email.delivered",
        },
        {
          scenario: "bounce",
          recipient: "bounce+x@simulator.amazonses.com",
          messageId: missingId,
          expectedType: "email.bounced",
        },
      ],
      deadlineMs: 5_000,
      sleep: async () => {
        clock += 1_000;
      },
      now: () => clock,
    });

    const arrived = observed.find((event) => event.messageId === arrivedId);
    expect(arrived).toMatchObject({
      arrived: true,
      status: "delivered",
      typeMatches: true,
    });
    const missing = observed.find((event) => event.messageId === missingId);
    expect(missing).toMatchObject({ arrived: false, typeMatches: false });

    await db
      .delete(emailEvents)
      .where(inArray(emailEvents.messageId, [arrivedId]));
  });
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

describe("the delivery-proof report", () => {
  it("names every link and never renders the webhook secret", async () => {
    const { result, names } = await runExecute();
    const report: DeliveryProofReport = {
      runId: names.runId,
      region: "us",
      awsRegion: "us-east-1",
      clientId: "aws",
      publicUrl: PUBLIC_URL,
      sendFrom: SEND_FROM,
      topicArn: TOPIC_ARN,
      names,
      leftoverTenants: [],
      links: [
        {
          id: "tunnel_health",
          title: "cloudflared tunnel → control plane /api/health",
          status: "exercised",
          detail: "answered 200",
        },
        ...result.links,
      ],
      steps: result.steps,
      events: result.events,
      stub: result.stub,
      findings: result.findings,
      notes: result.notes,
      cleanup: result.cleanup,
    };
    const rendered = renderProofReport(report);
    for (const id of PROOF_LINK_IDS) {
      expect(rendered).toContain(id);
    }
    expect(rendered).toContain(names.tenantName);
    expect(rendered).toContain("email.bounced");
    expect(rendered).toMatch(/NOT exercised/i);
    expect(rendered).not.toContain(WEBHOOK_SECRET);
  });

  it("shouts a finding rather than burying it", async () => {
    const { result, names } = await runExecute();
    const report: DeliveryProofReport = {
      runId: names.runId,
      region: "us",
      awsRegion: "us-east-1",
      clientId: "aws",
      publicUrl: PUBLIC_URL,
      sendFrom: SEND_FROM,
      topicArn: TOPIC_ARN,
      names,
      leftoverTenants: [],
      links: result.links,
      steps: result.steps,
      events: result.events,
      stub: result.stub,
      findings: ["the simulator bounce address was SUPPRESSED"],
      notes: result.notes,
      cleanup: result.cleanup,
    };
    const rendered = renderProofReport(report);
    expect(rendered).toMatch(/FINDING/);
    expect(rendered).toContain("SUPPRESSED");
  });
});
