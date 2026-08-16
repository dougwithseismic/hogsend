import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { SES_PUBLISHED_EVENT_TYPES } from "../../src/services/ses-tenants";
import { SES_VERBS, type SesClient } from "../../src/ses/contract";
import { FakeSesClient } from "../../src/ses/fake";
import type {
  SesCreateIdentityInput,
  SesIdentity,
  SesIdentityRef,
} from "../../src/ses/types";
import { SesError } from "../../src/ses/types";
import type { SubstrateRegion } from "../../src/substrate/types";
import type { RecordedStep, TenantCensus } from "../src/ses-walkthrough";
import {
  ACCESS_KEY_VAR,
  assertAccountSweepable,
  CleanupStack,
  CONFIRMATION_FLAG,
  compareAnswers,
  DivergenceRecorder,
  executeWalkthrough,
  isWalkthroughTenantName,
  parseWalkthroughArgs,
  renderReport,
  requireAwsCredentials,
  requireConfirmation,
  runWalkthrough,
  SECRET_KEY_VAR,
  scrub,
  WALKTHROUGH_TENANT_PREFIX,
  WalkthroughRefusal,
  walkthroughNames,
  walkthroughRunId,
} from "../src/ses-walkthrough";
import { WALKTHROUGH_PUBLISHED_EVENT_TYPES } from "../src/ses-walkthrough/walkthrough";

/**
 * The parts of the live SES walkthrough that are testable with no AWS account.
 *
 * The script itself is deliberately NOT a vitest file (PRD 11): it needs real
 * credentials and creates billable stateful resources, so a `describe.skipIf`
 * that no-ops in CI would read as coverage and assert nothing. What IS testable
 * is everything that decides whether the script is allowed to touch AWS at all,
 * plus the comparison logic that turns its output into a report.
 */

const RUN_ID = "20260811-120000-a1b2c3";
const IDENTITY_BASE = "walkthrough.example.com";

function options(extra: string[] = []) {
  return parseWalkthroughArgs([
    CONFIRMATION_FLAG,
    "--run-id",
    RUN_ID,
    "--identity-base",
    IDENTITY_BASE,
    ...extra,
  ]);
}

/**
 * A stand-in for an AWS that answers with a DKIM block of its own.
 *
 * The walkthrough's token check reads what the REAL side reported, and with a
 * Fake on both sides that is always a correct BYODKIM echo — so the branch
 * that matters (tokens under an `AWS_SES` origin, which really are CNAMEs) is
 * unreachable without overriding one side's answer.
 */
class DkimOverridingSes extends FakeSesClient {
  private readonly dkimOverride: Partial<SesIdentity["dkim"]>;

  constructor(dkimOverride: Partial<SesIdentity["dkim"]>) {
    super({ region: "us" });
    this.dkimOverride = dkimOverride;
  }

  override async createIdentity(
    input: SesCreateIdentityInput,
  ): Promise<SesIdentity> {
    return this.patch(await super.createIdentity(input));
  }

  override async getIdentity(input: SesIdentityRef): Promise<SesIdentity> {
    return this.patch(await super.getIdentity(input));
  }

  private patch(identity: SesIdentity): SesIdentity {
    return { ...identity, dkim: { ...identity.dkim, ...this.dkimOverride } };
  }
}

/** A fixed keypair, so a test can assert the private half never surfaces. */
const KEYPAIR = {
  selector: "hogsend",
  privateKey: "PRIVATE-KEY-THAT-MUST-NEVER-BE-PRINTED",
  publicKey: "PUBLIC-KEY-MATERIAL",
};

describe("walkthrough guards — credentials", () => {
  it("refuses with NEITHER var, naming both", () => {
    let thrown: unknown;
    try {
      requireAwsCredentials({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalkthroughRefusal);
    expect((thrown as WalkthroughRefusal).code).toBe("no_credentials");
    expect((thrown as Error).message).toContain(ACCESS_KEY_VAR);
    expect((thrown as Error).message).toContain(SECRET_KEY_VAR);
  });

  it("refuses with only the access key, still naming both", () => {
    expect(() => requireAwsCredentials({ [ACCESS_KEY_VAR]: "AKIA" })).toThrow(
      WalkthroughRefusal,
    );
    try {
      requireAwsCredentials({ [ACCESS_KEY_VAR]: "AKIA" });
    } catch (error) {
      expect((error as Error).message).toContain(ACCESS_KEY_VAR);
      expect((error as Error).message).toContain(SECRET_KEY_VAR);
    }
  });

  it("refuses with only the secret key", () => {
    expect(() => requireAwsCredentials({ [SECRET_KEY_VAR]: "s3cret" })).toThrow(
      WalkthroughRefusal,
    );
  });

  it("treats a whitespace-only value as absent", () => {
    expect(() =>
      requireAwsCredentials({
        [ACCESS_KEY_VAR]: "   ",
        [SECRET_KEY_VAR]: "s3cret",
      }),
    ).toThrow(WalkthroughRefusal);
  });

  it("returns the trimmed pair when both are present", () => {
    expect(
      requireAwsCredentials({
        [ACCESS_KEY_VAR]: " AKIA ",
        [SECRET_KEY_VAR]: " s3cret ",
      }),
    ).toEqual({ accessKeyId: "AKIA", secretAccessKey: "s3cret" });
  });
});

describe("walkthrough guards — the confirmation flag", () => {
  it("parses to unconfirmed with no flag, and refuses", () => {
    const parsed = parseWalkthroughArgs([]);
    expect(parsed.confirmed).toBe(false);
    let thrown: unknown;
    try {
      requireConfirmation(parsed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalkthroughRefusal);
    expect((thrown as WalkthroughRefusal).code).toBe("not_confirmed");
    expect((thrown as Error).message).toContain(CONFIRMATION_FLAG);
  });

  it("passes with the flag", () => {
    const parsed = parseWalkthroughArgs([CONFIRMATION_FLAG]);
    expect(parsed.confirmed).toBe(true);
    expect(() => requireConfirmation(parsed)).not.toThrow();
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    expect(() => parseWalkthroughArgs(["--yolo"])).toThrow(WalkthroughRefusal);
  });

  it("refuses an unmapped region", () => {
    expect(() =>
      parseWalkthroughArgs([CONFIRMATION_FLAG, "--region", "ap-south-1"]),
    ).toThrow(WalkthroughRefusal);
  });
});

describe("walkthrough guards — the account census", () => {
  it("refuses when the account holds a tenant the script did not create", () => {
    let thrown: unknown;
    try {
      assertAccountSweepable([
        `${WALKTHROUGH_TENANT_PREFIX}${RUN_ID}`,
        "env-8f1c-real-customer",
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WalkthroughRefusal);
    expect((thrown as WalkthroughRefusal).code).toBe("account_not_empty");
    expect((thrown as Error).message).toContain("env-8f1c-real-customer");
  });

  it("accepts an empty account", () => {
    expect(assertAccountSweepable([])).toEqual({ leftovers: [] });
  });

  it("accepts — and reports — leftovers from a previous crashed run", () => {
    const previous = `${WALKTHROUGH_TENANT_PREFIX}20260101-000000-deadbe`;
    expect(assertAccountSweepable([previous])).toEqual({
      leftovers: [previous],
    });
  });
});

describe("run-scoped naming", () => {
  it("derives a run id from a clock and entropy, with no clock of its own", () => {
    expect(walkthroughRunId(new Date("2026-08-11T12:00:00Z"), "a1b2c3")).toBe(
      RUN_ID,
    );
  });

  it("namespaces every resource under the run id", () => {
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
    });
    expect(names.tenantName).toBe(`${WALKTHROUGH_TENANT_PREFIX}${RUN_ID}`);
    expect(names.configurationSetName).toBe(names.tenantName);
    expect(names.identityDomain).toBe(`${RUN_ID}.${IDENTITY_BASE}`);
    expect(names.mailFromDomain).toBe(`send.${names.identityDomain}`);
  });

  it("keeps the tenant name inside AWS's name shape", () => {
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
    });
    expect(names.tenantName.length).toBeLessThanOrEqual(64);
    expect(names.tenantName).toMatch(/^[a-z0-9-]+$/);
  });

  it("recognises only its own tenants as sweepable", () => {
    expect(isWalkthroughTenantName(`${WALKTHROUGH_TENANT_PREFIX}x`)).toBe(true);
    expect(isWalkthroughTenantName("env-some-customer")).toBe(false);
  });

  it("uses an explicit --identity-domain verbatim when given", () => {
    const parsed = parseWalkthroughArgs([
      CONFIRMATION_FLAG,
      "--identity-domain",
      "fixed.example.com",
    ]);
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
      ...(parsed.identityDomain
        ? { identityDomain: parsed.identityDomain }
        : {}),
    });
    expect(names.identityDomain).toBe("fixed.example.com");
  });
});

describe("the divergence recorder's comparison", () => {
  it("reports BOTH of two known-different answers, not just the first", () => {
    const divergences = compareAnswers({
      verb: "getTenant",
      label: "getTenant",
      real: { outcome: "ok", value: { name: "t", sendingStatus: "DISABLED" } },
      fake: { outcome: "ok", value: { name: "u", sendingStatus: "ENABLED" } },
    });
    expect(divergences.map((d) => d.path).sort()).toEqual([
      "name",
      "sendingStatus",
    ]);
    expect(divergences.every((d) => d.reason === "value")).toBe(true);
  });

  it("reports nothing when the two answers agree", () => {
    expect(
      compareAnswers({
        verb: "getTenant",
        label: "getTenant",
        real: { outcome: "ok", value: { a: 1, b: [1, 2] } },
        fake: { outcome: "ok", value: { a: 1, b: [1, 2] } },
      }),
    ).toEqual([]);
  });

  it("reports an outcome mismatch when one side threw", () => {
    const divergences = compareAnswers({
      verb: "createTenant",
      label: "createTenant",
      real: { outcome: "error", kind: "invalid", message: "nope" },
      fake: { outcome: "ok", value: { name: "t" } },
    });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.reason).toBe("outcome");
  });

  it("compares errors on KIND, never on the message", () => {
    expect(
      compareAnswers({
        verb: "getTenant",
        label: "getTenant",
        real: { outcome: "error", kind: "not_found", message: "AWS words" },
        fake: { outcome: "error", kind: "not_found", message: "fake words" },
      }),
    ).toEqual([]);

    const mismatched = compareAnswers({
      verb: "getTenant",
      label: "getTenant",
      real: { outcome: "error", kind: "invalid", message: "x" },
      fake: { outcome: "error", kind: "not_found", message: "y" },
    });
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0]?.reason).toBe("kind");
  });

  it("ignores the VALUE of a volatile path but still checks its type", () => {
    expect(
      compareAnswers({
        verb: "createTenant",
        label: "createTenant",
        real: { outcome: "ok", value: { arn: "arn:aws:…:9911", n: 1 } },
        fake: { outcome: "ok", value: { arn: "arn:aws:…:0000", n: 1 } },
        volatile: ["arn"],
      }),
    ).toEqual([]);

    const typed = compareAnswers({
      verb: "createTenant",
      label: "createTenant",
      real: { outcome: "ok", value: { arn: null } },
      fake: { outcome: "ok", value: { arn: "arn:…" } },
      volatile: ["arn"],
    });
    expect(typed).toHaveLength(1);
    expect(typed[0]?.reason).toBe("type");
  });

  it("reports a key one side has and the other does not", () => {
    const divergences = compareAnswers({
      verb: "getReputationEntity",
      label: "getReputationEntity",
      real: { outcome: "ok", value: { reference: "a", policyArn: "arn:…" } },
      fake: { outcome: "ok", value: { reference: "a" } },
      volatile: ["reference"],
    });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      path: "policyArn",
      reason: "presence",
    });
  });

  it("reports an array whose length differs", () => {
    const divergences = compareAnswers({
      verb: "createIdentity",
      label: "createIdentity",
      real: { outcome: "ok", value: { tokens: ["a", "b", "c"] } },
      fake: { outcome: "ok", value: { tokens: [] } },
    });
    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.path).toBe("tokens");
  });

  it("matches a volatile path through an array index wildcard", () => {
    expect(
      compareAnswers({
        verb: "listRecommendations",
        label: "listRecommendations",
        real: { outcome: "ok", value: { r: [{ at: "2026" }] } },
        fake: { outcome: "ok", value: { r: [{ at: "1999" }] } },
        volatile: ["r.*.at"],
      }),
    ).toEqual([]);
  });

  it("collects instead of throwing when the real call fails", async () => {
    const recorder = new DivergenceRecorder();
    const result = await recorder.compare({
      verb: "getTenant",
      input: { tenantName: "t" },
      real: () => {
        throw new SesError("boom", { kind: "not_found" });
      },
      fake: async () => ({ name: "t" }),
    });
    expect(result.ok).toBe(false);
    expect(recorder.divergences).toHaveLength(1);
    expect(recorder.steps[0]?.real).toMatchObject({
      outcome: "error",
      kind: "not_found",
    });
  });

  it("records a skip with its reason and never compares it", () => {
    const recorder = new DivergenceRecorder();
    recorder.skip({ verb: "sendEmail", reason: "no --send-to" });
    expect(recorder.divergences).toEqual([]);
    expect(recorder.steps[0]).toMatchObject({
      verb: "sendEmail",
      status: "skipped",
      skipReason: "no --send-to",
    });
  });
});

describe("the cleanup stack", () => {
  it("runs in REVERSE and keeps going when a step throws", async () => {
    const order: string[] = [];
    const stack = new CleanupStack();
    stack.push("a", async () => {
      order.push("a");
    });
    stack.push("b", async () => {
      order.push("b");
      throw new Error("b failed");
    });
    stack.push("c", async () => {
      order.push("c");
    });

    const report = await stack.run();
    expect(order).toEqual(["c", "b", "a"]);
    expect(report.order).toEqual(["c", "b", "a"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.label).toBe("b");
    expect(report.failed[0]?.error).toContain("b failed");
  });

  it("never throws, even with nothing registered", async () => {
    await expect(new CleanupStack().run()).resolves.toEqual({
      order: [],
      failed: [],
    });
  });
});

describe("runWalkthrough refusals", () => {
  const env = { [ACCESS_KEY_VAR]: "AKIA", [SECRET_KEY_VAR]: "s3cret" };
  /**
   * Deliberately typed as the real dep and left un-implemented: if a guard ever
   * lets execution reach it, the run throws rather than quietly proceeding —
   * so "no AWS client was constructed" is enforced twice over.
   */
  let resolveClient: Mock<(region: SubstrateRegion) => SesClient>;
  let census: Mock<TenantCensus>;
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    resolveClient = vi.fn();
    census = vi.fn(async () => []);
  });

  it("refuses with no credentials, naming both vars and constructing no client", async () => {
    const result = await runWalkthrough([CONFIRMATION_FLAG], {
      env: {},
      resolveClient,
      census: () => census,
      out: (line) => lines.push(line),
    });
    expect(result.exitCode).not.toBe(0);
    expect(resolveClient).not.toHaveBeenCalled();
    expect(census).not.toHaveBeenCalled();
    const printed = lines.join("\n");
    expect(printed).toContain(ACCESS_KEY_VAR);
    expect(printed).toContain(SECRET_KEY_VAR);
  });

  it("refuses without the confirmation flag and makes no AWS call", async () => {
    const result = await runWalkthrough([], {
      env,
      resolveClient,
      census: () => census,
      out: (line) => lines.push(line),
    });
    expect(result.exitCode).not.toBe(0);
    expect(resolveClient).not.toHaveBeenCalled();
    expect(census).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain(CONFIRMATION_FLAG);
  });

  it("refuses a tenant-bearing account before resolving a SES client", async () => {
    const foreign: Mock<TenantCensus> = vi.fn(async () => [
      "env-a-real-customer",
    ]);
    const result = await runWalkthrough([CONFIRMATION_FLAG], {
      env,
      resolveClient,
      census: () => foreign,
      out: (line) => lines.push(line),
    });
    expect(result.exitCode).not.toBe(0);
    expect(foreign).toHaveBeenCalled();
    expect(resolveClient).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("env-a-real-customer");
  });

  it("refuses when the resolved client is not the AWS one", async () => {
    const result = await runWalkthrough([CONFIRMATION_FLAG], {
      env,
      resolveClient: () => new FakeSesClient({ region: "us" }),
      census: () => census,
      out: (line) => lines.push(line),
    });
    expect(result.exitCode).not.toBe(0);
    expect(lines.join("\n")).toMatch(/fake/i);
  });
});

describe("executeWalkthrough", () => {
  async function run(
    extra: string[] = [],
    seedReal: (client: FakeSesClient) => void = () => {},
    realClient?: FakeSesClient,
  ) {
    const real = realClient ?? new FakeSesClient({ region: "us" });
    const fake = new FakeSesClient({ region: "us" });
    seedReal(real);
    const parsed = options(extra);
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
    });
    const result = await executeWalkthrough({
      real,
      fake,
      options: parsed,
      names,
      keypair: KEYPAIR,
    });
    return { real, fake, result, names };
  }

  it("accounts for every one of the twenty contract verbs", async () => {
    const { result } = await run();
    const seen = new Set(result.steps.map((step) => step.verb));
    expect([...SES_VERBS].filter((verb) => !seen.has(verb))).toEqual([]);
  });

  it("finds NO divergence when both sides are the same implementation", async () => {
    const { result } = await run();
    expect(result.divergences).toEqual([]);
    expect(result.aborted).toBeUndefined();
  });

  it("leaves the account as it found it", async () => {
    const { real, names } = await run();
    expect(real.__tenant(names.tenantName)).toBeUndefined();
    expect(real.__configurationSet(names.configurationSetName)).toBeUndefined();
  });

  it("treats the echoed SELECTOR as the one record, not a second one", async () => {
    const { result } = await run();

    // AWS echoes the selector we supplied back in `DkimAttributes.Tokens` for
    // a BYODKIM identity — "this object contains the selector for the public
    // key" (SESv2 API Reference, `DkimAttributes`) — so a non-empty list here
    // is NOT a CNAME the customer has to publish and the ONE TXT record claim
    // survives. The walkthrough used to warn on emptiness alone, which would
    // have raised a false product alarm on every run.
    expect(result.dkim.awsTokens).toEqual([KEYPAIR.selector]);
    expect(result.notes.filter((note) => /token/i.test(note))).toEqual([]);
  });

  it("WARNS when tokens arrive with an AWS_SES origin, where they are real CNAMEs", async () => {
    const { result } = await run(
      [],
      () => {},
      new DkimOverridingSes({
        origin: "AWS_SES",
        tokens: ["tok-1", "tok-2", "tok-3"],
      }),
    );

    // The case the emptiness check was reaching for and missed: Easy DKIM
    // tokens really would make it four records, and only the ORIGIN can tell
    // them apart from the selector echo.
    const warning = result.notes.find((note) => /Easy DKIM/i.test(note));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/make it 4/);
  });

  it("WARNS when a BYODKIM echo is not the selector we supplied", async () => {
    const { result } = await run(
      [],
      () => {},
      new DkimOverridingSes({ origin: "EXTERNAL", tokens: ["someone-elses"] }),
    );

    // The echo is only reassuring while it IS an echo. Anything else means
    // SES read a selector we did not send, and the published record is wrong.
    expect(result.notes.find((note) => /selector/i.test(note))).toMatch(
      /someone-elses/,
    );
  });

  it("reports the ONE TXT record BYODKIM claims", async () => {
    const { result, names } = await run();
    expect(result.dkim.records).toHaveLength(1);
    expect(result.dkim.records[0]).toMatchObject({
      type: "TXT",
      name: `hogsend._domainkey.${names.identityDomain}`,
      purpose: "dkim",
    });
    expect(result.dkim.records[0]?.value).toBe(`p=${KEYPAIR.publicKey}`);
  });

  it("never lets the DKIM private key into the report", async () => {
    const { result } = await run();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(KEYPAIR.privateKey);
    expect(serialized).toContain("<redacted>");
  });

  it("skips the send leg with a reason when no recipient is given", async () => {
    const { result } = await run();
    const send = result.steps.find((step) => step.verb === "sendEmail");
    expect(send?.status).toBe("skipped");
    expect(send?.skipReason).toMatch(/--send-from|--send-to/);
  });

  it("skips the event destination when no SNS topic is configured", async () => {
    const { result } = await run();
    const step = result.steps.find(
      (candidate) => candidate.verb === "putEventDestination",
    );
    expect(step?.status).toBe("skipped");
    expect(step?.skipReason).toMatch(/topic/i);
  });

  it("exercises the event destination when a topic IS configured", async () => {
    const { result } = await run([
      "--sns-topic-arn",
      "arn:aws:sns:us-east-1:111111111111:hogsend-ses-events",
    ]);
    const step = result.steps.find(
      (candidate) => candidate.verb === "putEventDestination",
    );
    expect(step?.status).toBe("compared");
    expect(result.divergences).toEqual([]);
  });

  it("sends when both --send-from and --send-to are supplied", async () => {
    // The stand-in for AWS must already hold the operator's sender, VERIFIED —
    // that is the whole premise of `--send-from`, and the reason the
    // walkthrough advances only the Fake's copy with `__verifyIdentity`.
    const { result } = await run(
      [
        "--send-from",
        "ops@verified.example.com",
        "--send-to",
        "inbox@verified.example.com",
      ],
      (client) => {
        void client.createIdentity({ domain: "verified.example.com" });
        client.__verifyIdentity("verified.example.com");
      },
    );
    const send = result.steps.find((step) => step.verb === "sendEmail");
    expect(send?.status).toBe("compared");
    expect(send?.real).toMatchObject({ outcome: "ok" });

    const batch = result.steps.find((step) => step.verb === "sendBatch");
    expect(batch?.status).toBe("compared");
    expect(batch?.real).toMatchObject({ outcome: "ok" });

    expect(result.divergences).toEqual([]);
  });

  /** The `associateResource` step that names the operator's sender. */
  function senderAssociation(steps: RecordedStep[]) {
    return steps.find(
      (step) => step.label === "associateResource:sender-identity",
    );
  }

  it("associates the ADDRESS identity when the account holds one", async () => {
    // The bug the second live walkthrough found (2026-08-11). The script
    // derived the sender's ARN from the address's DOMAIN unconditionally, so
    // `ses-proof@hogsend.com` became `identity/hogsend.com` — an identity the
    // account does not hold. AWS answered "Identity <hogsend.com> does not
    // exist" and the two send verbs after it then failed 403, which read as a
    // Fake divergence rather than as the probe bug it was.
    const { result } = await run(
      [
        "--send-from",
        "ses-proof@hogsend.com",
        "--send-to",
        "inbox@hogsend.com",
      ],
      (client) => {
        // ONLY the address identity — the parent domain is not an identity at
        // all, which is exactly the live account's shape.
        void client.createIdentity({ domain: "ses-proof@hogsend.com" });
        client.__verifyIdentity("ses-proof@hogsend.com");
      },
    );

    const association = senderAssociation(result.steps);
    expect(association?.status).toBe("compared");
    expect(association?.input).toMatchObject({
      resourceArn: expect.stringMatching(/identity\/ses-proof@hogsend\.com$/),
    });
    expect(result.steps.find((step) => step.verb === "sendEmail")?.status).toBe(
      "compared",
    );
    expect(result.divergences).toEqual([]);
    // And it SAYS which form it derived, so a reader of the report never has
    // to re-derive it from the ARN.
    expect(result.notes.find((note) => /EMAIL_ADDRESS/.test(note))).toMatch(
      /ses-proof@hogsend\.com/,
    );
  });

  it("associates the parent DOMAIN identity when that is what the account holds", async () => {
    // The other identity type, and the reason the form is read off the ACCOUNT
    // rather than off the address's shape: the same `--send-from` resolves to a
    // different ARN depending on which identity exists.
    const { result } = await run(
      [
        "--send-from",
        "ops@verified.example.com",
        "--send-to",
        "inbox@verified.example.com",
      ],
      (client) => {
        void client.createIdentity({ domain: "verified.example.com" });
        client.__verifyIdentity("verified.example.com");
      },
    );

    expect(senderAssociation(result.steps)?.input).toMatchObject({
      resourceArn: expect.stringMatching(/identity\/verified\.example\.com$/),
    });
    expect(result.notes.find((note) => /\bDOMAIN\b/.test(note))).toMatch(
      /verified\.example\.com/,
    );
    expect(result.divergences).toEqual([]);
  });

  it("skips the send leg when the account holds no verified sender", async () => {
    // Never a guessed ARN and never a compared-and-diverged send: a sender the
    // account cannot send from makes the send verbs UNEXERCISED, and the
    // report has to say so rather than report a divergence of its own making.
    const { result } = await run([
      "--send-from",
      "nobody@unheard-of.example.com",
      "--send-to",
      "inbox@unheard-of.example.com",
    ]);

    const send = result.steps.find((step) => step.verb === "sendEmail");
    expect(send?.status).toBe("skipped");
    expect(send?.skipReason).toMatch(/nobody@unheard-of\.example\.com/);
    expect(send?.skipReason).toMatch(/neither exists/);
    expect(senderAssociation(result.steps)).toBeUndefined();
    expect(result.divergences).toEqual([]);
  });

  it("skips the send leg when the sender exists but is UNVERIFIED", async () => {
    // A separate obstacle from "no such identity", and the report has to tell
    // them apart: this one the operator fixes by finishing verification, the
    // other by creating an identity. Never falls through to the parent domain
    // either — SES resolves the send to the address identity that exists, so
    // associating the domain's ARN would name a resource the send ignores.
    const { result } = await run(
      [
        "--send-from",
        "pending@half-done.example.com",
        "--send-to",
        "inbox@half-done.example.com",
      ],
      (client) => {
        void client.createIdentity({ domain: "pending@half-done.example.com" });
        void client.createIdentity({ domain: "half-done.example.com" });
        client.__verifyIdentity("half-done.example.com");
      },
    );

    const send = result.steps.find((step) => step.verb === "sendEmail");
    expect(send?.status).toBe("skipped");
    expect(send?.skipReason).toMatch(/EMAIL_ADDRESS/);
    expect(send?.skipReason).toMatch(/NOT verified/);
    expect(senderAssociation(result.steps)).toBeUndefined();
  });

  it("tears down in reverse and reports nothing left behind", async () => {
    const { result } = await run();
    expect(result.cleanup.failed).toEqual([]);
    expect(result.cleanup.order.length).toBeGreaterThan(0);
  });

  it("still tears down everything it made when a step fails mid-walk", async () => {
    const real = new FakeSesClient({ region: "us" });
    const fake = new FakeSesClient({ region: "us" });
    // A permanent failure on the identity, part-way through: the tenant and
    // the configuration set already exist and MUST come back down.
    real.failNext(
      "createIdentity",
      new SesError("nope", { kind: "invalid", operation: "createIdentity" }),
    );
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
    });
    const result = await executeWalkthrough({
      real,
      fake,
      options: options(),
      names,
      keypair: KEYPAIR,
    });

    expect(result.divergences.length).toBeGreaterThan(0);
    expect(real.__tenant(names.tenantName)).toBeUndefined();
    expect(real.__configurationSet(names.configurationSetName)).toBeUndefined();
    expect(result.cleanup.failed).toEqual([]);
  });

  it("aborts — but still tears down — when the tenant cannot be created", async () => {
    const real = new FakeSesClient({ region: "us" });
    real.failNext(
      "createTenant",
      new SesError("denied", { kind: "invalid", operation: "createTenant" }),
    );
    const result = await executeWalkthrough({
      real,
      fake: new FakeSesClient({ region: "us" }),
      options: options(),
      names: walkthroughNames({ runId: RUN_ID, identityBase: IDENTITY_BASE }),
      keypair: KEYPAIR,
    });
    expect(result.aborted).toMatch(/createTenant/);
    expect(result.cleanup).toEqual({ order: [], failed: [] });
  });
});

describe("the report", () => {
  it("scrubs a secret out of the whole rendered string", () => {
    const secret = "PRIVATE-KEY-THAT-MUST-NEVER-BE-PRINTED";
    expect(scrub(`before ${secret} after`, [secret])).toBe(
      "before <redacted> after",
    );
  });

  it("refuses to scrub a value too short to be a secret", () => {
    // Scrubbing "us" out of every report would make it unreadable, and a
    // two-character secret is not one.
    expect(scrub("us-east-1", ["us"])).toBe("us-east-1");
  });

  it("renders a run, naming the divergence count and every skip", async () => {
    const real = new FakeSesClient({ region: "us" });
    const fake = new FakeSesClient({ region: "us" });
    const names = walkthroughNames({
      runId: RUN_ID,
      identityBase: IDENTITY_BASE,
    });
    const executed = await executeWalkthrough({
      real,
      fake,
      options: options(),
      names,
      keypair: KEYPAIR,
    });
    const rendered = renderReport({
      runId: RUN_ID,
      region: "us",
      awsRegion: "us-east-1",
      clientId: "aws",
      names,
      leftoverTenants: [],
      steps: executed.steps,
      divergences: executed.divergences,
      cleanup: executed.cleanup,
      dkim: executed.dkim,
      notes: executed.notes,
    });

    expect(rendered).toContain(names.tenantName);
    expect(rendered).toContain("0 divergence(s)");
    expect(rendered).toContain("SKIPPED");
    expect(rendered).toContain(`hogsend._domainkey.${names.identityDomain}`);
    expect(rendered).not.toContain(KEYPAIR.privateKey);
  });
});

describe("walkthrough published event types", () => {
  it("keeps the live walkthrough subscribing to the SAME set", () => {
    // The walkthrough (PRD 11) holds its own copy of this list because it is a
    // standalone script that must not import the db-bound tenant service. A
    // copy that drifts has the one script we use to prove the Fake matches AWS
    // exercising a shape production no longer sends — so the copy is pinned
    // here rather than trusted.
    expect([...WALKTHROUGH_PUBLISHED_EVENT_TYPES]).toEqual([
      ...SES_PUBLISHED_EVENT_TYPES,
    ]);
  });
});
