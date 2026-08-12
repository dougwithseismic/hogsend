import { describe, expect, it } from "vitest";
import { AwsSesClient, classifySesError } from "../ses/aws";
import { resolveSesRegion, SES_VERBS } from "../ses/contract";
import { FAKE_SES_CLOCK, FAKE_SES_ID, FakeSesClient } from "../ses/fake";
import type { SesMessage } from "../ses/types";
import { SesError } from "../ses/types";

/**
 * The Fake is the whole point of PRD 02: PRDs 03 and 05–09 test against it, so
 * its state machine is the thing under test here, not a convenience.
 *
 * Two properties are asserted relentlessly:
 *  1. DETERMINISM — no wall-clock, no RNG. Two fresh instances driven with the
 *     same inputs produce byte-identical output, which is what lets a
 *     downstream suite assert an id rather than record a sample. The one
 *     timestamp AWS makes the Fake report comes off a clock that is a FIXED
 *     constant unless a test injects its own.
 *  2. REAL TRANSITIONS — an identity is unverified until something verifies it,
 *     a paused tenant refuses to send. A fake that answered "verified" on
 *     creation would let PRD 07 ship a domain flow that never waits.
 */

const TENANT = "env-11111111-1111-4111-8111-111111111111";
const DOMAIN = "acme.test";
const IDENTITY_ARN = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

function message(overrides: Partial<SesMessage> = {}): SesMessage {
  return {
    from: "hello@acme.test",
    to: ["buyer@example.test"],
    subject: "Welcome",
    html: "<p>hi</p>",
    text: "hi",
    ...overrides,
  };
}

function fake(): FakeSesClient {
  return new FakeSesClient({ region: "us" });
}

async function tenantFake(): Promise<FakeSesClient> {
  const client = fake();
  await client.createTenant({ tenantName: TENANT });
  return client;
}

/**
 * Tenant + verified, tenant-associated identity — the state a fully
 * provisioned environment actually has, and what the send path requires:
 * the fake enforces the wire's own sender-side preconditions (verified
 * identity, tenant association), so a send test has to arrange them the way
 * a real provision would.
 */
async function sendReadyFake(): Promise<FakeSesClient> {
  const client = await tenantFake();
  await client.createIdentity({ domain: DOMAIN });
  client.__verifyIdentity(DOMAIN);
  await client.associateResource({
    tenantName: TENANT,
    resourceArn: IDENTITY_ARN,
  });
  return client;
}

describe("resolveSesRegion", () => {
  it("maps every SubstrateRegion to its pinned SES region", () => {
    expect(resolveSesRegion("us")).toBe("us-east-1");
    expect(resolveSesRegion("eu")).toBe("eu-west-1");
  });

  it("refuses anything outside the mapping", () => {
    // SES tenants are region-scoped and do not replicate (DECISIONS §3.3), so a
    // client that silently accepted an unmapped region would mint a tenant
    // nobody can find again.
    for (const bad of ["ap-south-1", "us-east-1", "US", "", "eu ", "global"]) {
      const error = (() => {
        try {
          resolveSesRegion(bad);
          return undefined;
        } catch (thrown) {
          return thrown;
        }
      })();
      expect(
        error,
        `expected ${JSON.stringify(bad)} to be rejected`,
      ).toBeInstanceOf(SesError);
      expect((error as SesError).kind).toBe("invalid");
    }
  });
});

describe("the account read", () => {
  it("answers the SANDBOX account we actually have, verbatim from AWS", async () => {
    // Observed against the live account on 2026-08-11 (`aws sesv2
    // get-account`): production access NOT granted, sending enabled, 200 a
    // day, 1 a second. The Fake models AWS, and AWS's answer here is what
    // decides whether Hogsend Email may be activated at all — a Fake that
    // reported production access would certify the exact bug the gate exists
    // to stop.
    const account = await fake().getAccount();
    expect(account).toEqual({
      productionAccessEnabled: false,
      sendingEnabled: true,
      enforcementStatus: "HEALTHY",
      max24HourSend: 200,
      maxSendRate: 1,
    });
  });

  it("moves to production access, and to a SHUTDOWN account, as AWS does", async () => {
    const client = fake();
    client.__grantProductionAccess();
    const granted = await client.getAccount();
    expect(granted.productionAccessEnabled).toBe(true);
    // The opening quota requested in `docs/ses-production-access-request.md`.
    expect(granted.max24HourSend).toBe(50_000);
    expect(granted.maxSendRate).toBe(14);

    // The same account pause `sendEmail` already refuses on, read through the
    // account: AWS reports it as `SendingEnabled: false` with an
    // `EnforcementStatus` of `SHUTDOWN`.
    client.__pauseAccount();
    const paused = await client.getAccount();
    expect(paused.sendingEnabled).toBe(false);
    expect(paused.enforcementStatus).toBe("SHUTDOWN");
    expect(paused.productionAccessEnabled).toBe(true);
  });
});

describe("the SES contract surface", () => {
  it("is exactly TWENTY verbs, and both implementations answer all of them", () => {
    // A silent drop is the failure this guards: a verb deleted from the
    // interface takes its callers' behaviour with it and nothing else notices,
    // because a Fake that no longer has a method is just a Fake nobody calls.
    expect(SES_VERBS).toHaveLength(20);
    expect(new Set(SES_VERBS).size).toBe(20);

    const implementations = [
      new FakeSesClient({ region: "us" }),
      new AwsSesClient({ region: "us", send: async () => ({}) }),
    ];
    for (const client of implementations) {
      for (const verb of SES_VERBS) {
        expect(typeof client[verb], `${client.id}.${verb}`).toBe("function");
      }
    }
  });

  it("groups the verbs the way the AWS operations actually group", () => {
    // `putSuppressionScope` is a TENANT operation
    // (`PutTenantSuppressionAttributes`), not a configuration-set one. It was
    // grouped under "config set" in an earlier draft of the spec, and the
    // config-set call it would have reached CANNOT set tenant scope — the bug
    // would have been a silent cross-tenant suppression leak.
    expect(SES_VERBS).toContain("putSuppressionScope");
    expect(SES_VERBS).toContain("getTenant");
    expect(SES_VERBS).toContain("getReputationEntity");
  });
});

describe("FakeSesClient construction", () => {
  it("requires a region and reports both halves of the mapping", () => {
    const client = new FakeSesClient({ region: "eu" });
    expect(client.id).toBe(FAKE_SES_ID);
    expect(client.region).toBe("eu");
    expect(client.awsRegion).toBe("eu-west-1");
  });

  it("rejects a region outside the mapping at construction", () => {
    expect(() => new FakeSesClient({ region: "ap-south-1" as "us" })).toThrow(
      SesError,
    );
  });
});

describe("FakeSesClient tenants", () => {
  it("mints a tenant whose identity is derived from its name", async () => {
    const a = await fake().createTenant({ tenantName: TENANT });
    const b = await fake().createTenant({ tenantName: TENANT });

    expect(a).toEqual(b);
    expect(a.name).toBe(TENANT);
    expect(a.sendingStatus).toBe("ENABLED");
    expect(a.arn).toContain("us-east-1");
    expect(a.arn).toContain(TENANT);
  });

  it("returns the EXISTING tenant on a second create, state intact", async () => {
    const client = fake();
    const first = await client.createTenant({ tenantName: TENANT });

    // Mutate state BETWEEN the creates. This is what makes the assertion
    // real: ids and ARNs are name-derived, so a fake that quietly RE-MINTED
    // the tenant would hand back a byte-identical row and a same-length
    // tenant list — the only observable difference is whether accumulated
    // state survives, which is what the AWS client provably preserves
    // (create → already_exists → getTenant, state untouched).
    await client.putSuppressionScope({
      tenantName: TENANT,
      scope: "TENANT",
      reasons: ["BOUNCE"],
    });
    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });

    const second = await client.createTenant({
      tenantName: TENANT,
      tags: { environment: "production" },
    });

    // Provisioning is resumable: a re-driven step must not throw, must not
    // mint a second tenant, and must not RESET the one it finds.
    expect(second).toMatchObject({
      name: first.name,
      id: first.id,
      arn: first.arn,
      sendingStatus: "DISABLED",
    });
    expect(client.__tenant(TENANT)).toMatchObject({
      suppressionScope: "TENANT",
      suppressedReasons: ["BOUNCE"],
    });
    expect(client.__tenants()).toHaveLength(1);
  });

  it("makes delete final — a second delete is a not-found", async () => {
    const client = await tenantFake();
    await client.deleteTenant({ tenantName: TENANT });

    await expect(
      client.deleteTenant({ tenantName: TENANT }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(client.__tenants()).toHaveLength(0);
  });

  it("reads a tenant back, and refuses one that is not there", async () => {
    const client = await tenantFake();

    // `CreateTenant` returns the ARN only on the call that actually created
    // the tenant, so every later reader — the idempotent create, both
    // reputation writes — needs this read-back.
    const read = await client.getTenant({ tenantName: TENANT });
    expect(read).toEqual(await client.createTenant({ tenantName: TENANT }));

    await client.deleteTenant({ tenantName: TENANT });
    await expect(
      client.getTenant({ tenantName: TENANT }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("puts the suppression scope on the TENANT, not on a configuration set", async () => {
    const client = await tenantFake();

    await client.putSuppressionScope({
      tenantName: TENANT,
      scope: "TENANT",
      reasons: ["BOUNCE", "COMPLAINT"],
    });

    // TENANT scope is the isolation primitive, and it is a TENANT operation
    // (`PutTenantSuppressionAttributes`). The similarly-named configuration-set
    // call cannot set it: wiring that one instead would leave every tenant on
    // the ACCOUNT list, so one customer's hard bounce would suppress that
    // address for everybody — silently, with no error anywhere.
    expect(client.__tenant(TENANT)).toMatchObject({
      suppressionScope: "TENANT",
      suppressedReasons: ["BOUNCE", "COMPLAINT"],
    });

    await expect(
      client.putSuppressionScope({ tenantName: "env-nope", scope: "TENANT" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("REPLACES the suppression attributes on every put, like the AWS PUT", async () => {
    const client = await tenantFake();
    await client.putSuppressionScope({
      tenantName: TENANT,
      scope: "TENANT",
      reasons: ["BOUNCE", "COMPLAINT"],
    });

    await client.putSuppressionScope({ tenantName: TENANT, scope: "ACCOUNT" });

    // `PutTenantSuppressionAttributes` is a PUT: an omitted field is a reset,
    // not a keep. A fake that merged would let a re-drive that drops `reasons`
    // pass in tests and clear them in production.
    expect(client.__tenant(TENANT)?.suppressionScope).toBe("ACCOUNT");
    expect(client.__tenant(TENANT)?.suppressedReasons).toBeUndefined();
  });

  it("associates resources idempotently and refuses an unknown tenant", async () => {
    const client = await tenantFake();
    const resourceArn = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;
    // The identity has to EXIST before it can be associated — the order
    // production provisions in, and now the order the Fake enforces.
    await client.createIdentity({ domain: DOMAIN });

    await client.associateResource({ tenantName: TENANT, resourceArn });
    await client.associateResource({ tenantName: TENANT, resourceArn });
    expect(client.__tenant(TENANT)?.resources).toEqual([resourceArn]);

    await client.disassociateResource({ tenantName: TENANT, resourceArn });
    expect(client.__tenant(TENANT)?.resources).toEqual([]);

    await expect(
      client.associateResource({ tenantName: "env-nope", resourceArn }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      client.disassociateResource({ tenantName: TENANT, resourceArn }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses to associate a resource that does not exist", async () => {
    // AWS's answer on the live walkthrough of 2026-08-11, verbatim: "Identity
    // <hogsend.com> does not exist", a `NotFoundException` — where the Fake
    // said `ok`. An association naming a typo'd, deleted or not-yet-created
    // resource was therefore green here and 404s in production, and the send
    // that follows it then 403s for a reason no test in this repo could see.
    const client = await tenantFake();
    const configurationSetArn =
      "arn:aws:ses:us-east-1:000000000000:configuration-set/cs-1";

    await expect(
      client.associateResource({
        tenantName: TENANT,
        resourceArn: IDENTITY_ARN,
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      client.associateResource({
        tenantName: TENANT,
        resourceArn: configurationSetArn,
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    // Refused means NOT recorded: a tenant must never come away holding a
    // membership AWS rejected.
    expect(client.__tenant(TENANT)?.resources).toEqual([]);

    // Creating each resource is the ONE thing that unlocks its association —
    // create-then-associate, the order both provisioners already use.
    await client.createIdentity({ domain: DOMAIN });
    await client.createConfigurationSet({ configurationSetName: "cs-1" });
    await client.associateResource({
      tenantName: TENANT,
      resourceArn: IDENTITY_ARN,
    });
    await client.associateResource({
      tenantName: TENANT,
      resourceArn: configurationSetArn,
    });
    expect(client.__tenant(TENANT)?.resources).toEqual([
      IDENTITY_ARN,
      configurationSetArn,
    ]);
  });

  it("refuses an ARN naming a resource no tenant can hold", async () => {
    // A tenant associates exactly two kinds of resource, so an ARN of any
    // other shape is one whose existence the Fake cannot check. Waving it
    // through unchecked is precisely the hole the rule above closes, so it is
    // refused instead — `invalid`, because the ARN is the thing that is wrong,
    // not a resource that is missing.
    const client = await tenantFake();

    await expect(
      client.associateResource({
        tenantName: TENANT,
        resourceArn: "arn:aws:sns:us-east-1:000000000000:hogsend-ses-events",
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      client.associateResource({ tenantName: TENANT, resourceArn: DOMAIN }),
    ).rejects.toMatchObject({ kind: "invalid" });
    expect(client.__tenant(TENANT)?.resources).toEqual([]);
  });
});

describe("FakeSesClient sending", () => {
  it("records the message and issues a deterministic id", async () => {
    const client = await sendReadyFake();

    const first = await client.sendEmail({
      tenantName: TENANT,
      configurationSetName: "cs-1",
      message: message(),
    });
    const second = await client.sendEmail({
      tenantName: TENANT,
      message: message({ subject: "Second" }),
    });

    expect(first.messageId).toBe("fake-ses-message-1");
    expect(second.messageId).toBe("fake-ses-message-2");
    expect(client.__sent()).toHaveLength(2);
    expect(client.__sent()[0]).toMatchObject({
      tenantName: TENANT,
      configurationSetName: "cs-1",
      messageId: "fake-ses-message-1",
    });
    expect(client.__sent()[0]?.message.subject).toBe("Welcome");
  });

  it("records attachments verbatim, through sendEmail AND sendBatch", async () => {
    // The wave's rule: contract, aws.ts and Fake move together. A Fake whose
    // recorded message dropped this field would let every test above the seam
    // assert a wire that never carried the file — the exact way 1473 green
    // tests once certified things SES does not do (PRD 14).
    const client = await sendReadyFake();
    const attachments = [
      {
        filename: "invoice.pdf",
        content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        contentType: "application/pdf",
        disposition: "inline" as const,
        contentId: "invoice@acme",
      },
    ];

    await client.sendEmail({
      tenantName: TENANT,
      message: message({ attachments }),
    });
    await client.sendBatch({
      tenantName: TENANT,
      messages: [
        message({ to: ["one@example.test"], attachments }),
        message({ to: ["two@example.test"] }),
      ],
    });

    const sent = client.__sent();
    expect(sent).toHaveLength(3);
    expect(sent[0]?.message.attachments).toEqual(attachments);
    // The batch is the same wire: attachments flow through per message, and a
    // file-less entry in the same batch records NO field at all — absent in,
    // absent out, exactly what crossed the seam.
    expect(sent[1]?.message.attachments).toEqual(attachments);
    expect(sent[2]?.message.attachments).toBeUndefined();
  });

  it("agrees with the AWS client about what one message's attachments say", async () => {
    // The SAME neutral message through both implementations: the facts a test
    // reads off the Fake (filename, bytes) must be the facts the real wire
    // sends, or the Fake is a story about a different message.
    const attachments = [
      { filename: "invoice.pdf", content: new Uint8Array([0x25, 0x50, 0x44]) },
    ];

    const fakeClient = await sendReadyFake();
    await fakeClient.sendEmail({
      tenantName: TENANT,
      message: message({ attachments }),
    });

    const commands: { input: unknown }[] = [];
    const awsClient = new AwsSesClient({
      region: "us",
      send: async (command) => {
        commands.push(command);
        return { MessageId: "aws-1" };
      },
    });
    await awsClient.sendEmail({
      tenantName: TENANT,
      message: message({ attachments }),
    });

    const recorded = fakeClient.__sent()[0]?.message.attachments?.[0];
    const wire = (
      commands[0]?.input as {
        Content: {
          Simple: { Attachments: { FileName: string; RawContent: unknown }[] };
        };
      }
    ).Content.Simple.Attachments[0];
    expect(wire?.FileName).toBe(recorded?.filename);
    expect(Array.from(wire?.RawContent as Uint8Array)).toEqual(
      Array.from(recorded?.content as Uint8Array),
    );
  });

  it("refuses to send on behalf of a tenant that does not exist", async () => {
    await expect(
      fake().sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses to send from an unverified identity, mirroring MessageRejected", async () => {
    const client = await tenantFake();

    // No identity at all — the wire answers MessageRejected ("Email address
    // is not verified"), which classifies as `invalid` and is permanent.
    const missing = await client
      .sendEmail({ tenantName: TENANT, message: message() })
      .catch((thrown: unknown) => thrown);
    expect(missing).toBeInstanceOf(SesError);
    expect((missing as SesError).kind).toBe("invalid");
    expect((missing as SesError).retryable).toBe(false);
    expect(client.__sent()).toHaveLength(0);

    // Created and associated but still PENDING: the DNS is not out yet.
    await client.createIdentity({ domain: DOMAIN });
    await client.associateResource({
      tenantName: TENANT,
      resourceArn: IDENTITY_ARN,
    });
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "invalid" });

    // Verification is the ONE thing that unlocks the send. A fake that
    // delivered any earlier would certify a send-before-verify flow green.
    client.__verifyIdentity(DOMAIN);
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).resolves.toEqual({ messageId: "fake-ses-message-1" });
  });

  it("refuses a verified identity that is NOT associated with the tenant", async () => {
    const client = await tenantFake();
    await client.createIdentity({ domain: DOMAIN });
    client.__verifyIdentity(DOMAIN);

    // `SendEmail`'s own contract: "the email sending operation will only
    // succeed if all referenced resources ... are associated with this
    // tenant". A provision that forgot `associateResource` must fail HERE,
    // in a test, not on its first customer send.
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "invalid" });

    await client.associateResource({
      tenantName: TENANT,
      resourceArn: IDENTITY_ARN,
    });
    await expect(
      client.sendEmail({
        tenantName: TENANT,
        // The display-name form must resolve to the same identity.
        message: message({ from: "Acme <hello@acme.test>" }),
      }),
    ).resolves.toEqual({ messageId: "fake-ses-message-1" });
  });

  it("refuses it with the KIND the AWS client gives AWS's own refusal", async () => {
    // The Fake modelling the rule is only half of it: a caller branches on
    // `kind`, so the Fake's refusal has to CLASSIFY the way the real one does
    // or a recovery path tested here is dead code in production. AWS's answer
    // is verbatim from the live walkthrough of 2026-08-11 — an
    // `AccessDeniedException`, HTTP 403 — and the expectation is derived from
    // `classifySesError` rather than spelled out, so the two cannot drift.
    const aws = classifySesError(
      Object.assign(
        new Error(
          "Tenant not associated with resources [arn:aws:ses:us-east-1:929600381829:identity/ses-proof@hogsend.com]",
        ),
        {
          name: "AccessDeniedException",
          $metadata: { httpStatusCode: 403 },
        },
      ),
      "sendEmail",
    );

    const client = await tenantFake();
    await client.createIdentity({ domain: DOMAIN });
    client.__verifyIdentity(DOMAIN);
    const refusal = await client
      .sendEmail({ tenantName: TENANT, message: message() })
      .catch((thrown: unknown) => thrown);

    expect(refusal).toBeInstanceOf(SesError);
    expect((refusal as SesError).kind).toBe(aws.kind);
    // And permanent on both sides: a retry cannot associate anything.
    expect((refusal as SesError).retryable).toBe(aws.retryable);
    expect(aws.retryable).toBe(false);
  });

  it("refuses an unassociated identity per ENTRY across a batch", async () => {
    // `sendBatch` fans out one send per message, so the association rule has
    // to reach every entry rather than only the first. The live walkthrough
    // diverged on all five compared per-entry fields for exactly this reason:
    // AWS refused each entry and the Fake had no failure to report.
    const client = await tenantFake();
    await client.createIdentity({ domain: DOMAIN });
    client.__verifyIdentity(DOMAIN);

    const result = await client.sendBatch({
      tenantName: TENANT,
      messages: [message({ to: ["one@example.test"] }), message()],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.status === "failed")).toBe(
      true,
    );
    expect(result.results[0]).toMatchObject({
      status: "failed",
      kind: "invalid",
    });
    expect(client.__sent()).toHaveLength(0);
  });

  it("fails CLOSED and non-retryably while the tenant is paused", async () => {
    const client = await sendReadyFake();
    client.__pauseTenant(TENANT);

    const error = await client
      .sendEmail({ tenantName: TENANT, message: message() })
      .catch((thrown: unknown) => thrown);

    // DECISIONS §6: a paused tenant is explicit, loud and never rerouted. A
    // retryable classification would make the relay spin on a verdict only a
    // human can change.
    expect(error).toBeInstanceOf(SesError);
    expect((error as SesError).kind).toBe("tenant_paused");
    expect((error as SesError).retryable).toBe(false);
    expect(client.__sent()).toHaveLength(0);

    client.__resumeTenant(TENANT);
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).resolves.toMatchObject({ messageId: "fake-ses-message-1" });
  });

  it("distinguishes an account-level pause from a tenant one", async () => {
    const client = await sendReadyFake();
    client.__pauseAccount();

    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "account_paused" });
  });

  it("returns one batch result per message, in order, with per-entry failures", async () => {
    const client = await sendReadyFake();
    client.__rejectRecipient("bounce@example.test");

    const result = await client.sendBatch({
      tenantName: TENANT,
      messages: [
        message({ to: ["one@example.test"] }),
        message({ to: ["bounce@example.test"] }),
        message({ to: ["three@example.test"] }),
      ],
    });

    // A batch is NOT all-or-nothing: one bad recipient must not lose the other
    // two, which is exactly what SES's own bulk result shape models.
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({
      status: "sent",
      messageId: "fake-ses-message-1",
    });
    expect(result.results[1]?.status).toBe("failed");
    expect(result.results[2]).toEqual({
      status: "sent",
      messageId: "fake-ses-message-2",
    });
    expect(client.__sent()).toHaveLength(2);
  });

  it("never throws wholesale: a scripted batch failure lands per entry", async () => {
    const client = await sendReadyFake();
    client.failNext("sendBatch");

    // The AWS implementation fans out one SendEmail per message and catches
    // per ENTRY, so its sendBatch can NEVER throw. A fake that threw
    // wholesale would let a caller test a catch-and-requeue path that is
    // dead code against the real wire.
    const result = await client.sendBatch({
      tenantName: TENANT,
      messages: [message(), message({ subject: "Second" })],
    });

    expect(result.results).toEqual([
      {
        status: "failed",
        kind: "transient",
        message: expect.stringContaining("scripted failure"),
      },
      {
        status: "failed",
        kind: "transient",
        message: expect.stringContaining("scripted failure"),
      },
    ]);
    expect(client.__sent()).toHaveLength(0);
    expect(client.calls.map((call) => call.method)).toContain("sendBatch");
  });
});

describe("FakeSesClient identities", () => {
  it("creates an identity NOT_STARTED, and only an explicit step verifies it", async () => {
    const client = fake();

    const created = await client.createIdentity({
      domain: DOMAIN,
      dkim: { selector: "hogsend", privateKey: "PRIVATE" },
    });

    expect(created.verifiedForSending).toBe(false);
    // `NOT_STARTED`, not `PENDING`, and this is AWS's observed answer rather
    // than a preference: the first live run (2026-08-11) had SES return
    // `NOT_STARTED` for both statuses on a freshly created identity, and the
    // SESv2 API Reference documents it as "The DKIM verification process
    // hasn't been initiated for the domain". The Fake said `PENDING`, so every
    // test reading it was reading a state AWS never returns here.
    expect(created.verificationStatus).toBe("NOT_STARTED");
    expect(created.dkim).toMatchObject({
      origin: "EXTERNAL",
      status: "NOT_STARTED",
      signingEnabled: true,
    });

    client.__verifyIdentity(DOMAIN);
    const verified = await client.getIdentity({ identity: DOMAIN });
    expect(verified.verifiedForSending).toBe(true);
    expect(verified.verificationStatus).toBe("SUCCESS");
    expect(verified.dkim.status).toBe("SUCCESS");
  });

  it("promotes NOT_STARTED to PENDING on the first read, as AWS does", async () => {
    // The status is NOT static, and only the live run of 2026-08-11 showed it:
    // `createIdentity` answered `NOT_STARTED` and `getIdentity` on the very
    // next call answered `PENDING`, because SES begins the DNS lookup
    // asynchronously as soon as the identity exists.
    //
    // This is the sequence every domain poller actually sees, so a Fake pinned
    // at `NOT_STARTED` would teach those callers a state that exists for one
    // call only. Pinned here because it is behaviour, not an implementation
    // detail — if the promotion is ever removed, this goes red.
    const client = fake();
    const created = await client.createIdentity({
      domain: DOMAIN,
      dkim: { selector: "hogsend", privateKey: "PRIVATE" },
    });
    expect(created.verificationStatus).toBe("NOT_STARTED");
    expect(created.dkim.status).toBe("NOT_STARTED");

    const first = await client.getIdentity({ identity: DOMAIN });
    expect(first.verificationStatus).toBe("PENDING");
    expect(first.dkim.status).toBe("PENDING");

    // Idempotent: it does not oscillate, and it never regresses a verified one.
    const second = await client.getIdentity({ identity: DOMAIN });
    expect(second.verificationStatus).toBe("PENDING");

    client.__verifyIdentity(DOMAIN);
    const verified = await client.getIdentity({ identity: DOMAIN });
    expect(verified.verificationStatus).toBe("SUCCESS");
    expect(verified.dkim.status).toBe("SUCCESS");
  });

  it("echoes the BYODKIM SELECTOR back as dkim.tokens, exactly as AWS does", async () => {
    const client = fake();
    const created = await client.createIdentity({
      domain: DOMAIN,
      dkim: { selector: "hogsend", privateKey: "PRIVATE" },
    });

    // AWS SESv2 API Reference, `DkimAttributes` → `Tokens`: "If you configured
    // DKIM authentication for the domain by providing your own public-private
    // key pair, then this object contains the selector for the public key."
    // It is our own selector coming back, NOT an Easy DKIM CNAME token, so it
    // implies NO second DNS record and the ONE TXT record claim is intact.
    // AWS returned `["hogsend"]` live on 2026-08-11 where the Fake returned
    // `[]`.
    expect(created.dkim.tokens).toEqual(["hogsend"]);
    expect(
      (await client.getIdentity({ identity: DOMAIN })).dkim.tokens,
    ).toEqual(["hogsend"]);
  });

  it("marks Easy DKIM when no BYODKIM key is supplied", async () => {
    const created = await fake().createIdentity({ domain: DOMAIN });
    expect(created.dkim.origin).toBe("AWS_SES");
    // The other origin, where tokens really ARE the CNAMEs a customer has to
    // publish — three of them, which is the record count BYODKIM avoids.
    expect(created.dkim.tokens).toHaveLength(3);
  });

  it("can be driven to a failed verification", async () => {
    const client = fake();
    await client.createIdentity({ domain: DOMAIN });
    client.__failIdentity(DOMAIN);

    const identity = await client.getIdentity({ identity: DOMAIN });
    expect(identity.verificationStatus).toBe("FAILED");
    expect(identity.verifiedForSending).toBe(false);
  });

  it("mirrors AWS on a duplicate identity and on an unknown one", async () => {
    const client = fake();
    await client.createIdentity({ domain: DOMAIN });

    await expect(
      client.createIdentity({ domain: DOMAIN }),
    ).rejects.toMatchObject({ kind: "already_exists" });
    await expect(
      client.getIdentity({ identity: "other.test" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("sets a custom MAIL FROM pending, then verifiable", async () => {
    const client = fake();
    await client.createIdentity({ domain: DOMAIN });

    await client.setMailFrom({
      identity: DOMAIN,
      mailFromDomain: `send.${DOMAIN}`,
    });
    expect((await client.getIdentity({ identity: DOMAIN })).mailFrom).toEqual({
      domain: `send.${DOMAIN}`,
      status: "PENDING",
      behaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });

    client.__verifyMailFrom(DOMAIN);
    expect(
      (await client.getIdentity({ identity: DOMAIN })).mailFrom?.status,
    ).toBe("SUCCESS");
  });

  it("deletes an identity, after which it is a not-found", async () => {
    const client = fake();
    await client.createIdentity({ domain: DOMAIN });
    await client.deleteIdentity({ identity: DOMAIN });

    await expect(
      client.getIdentity({ identity: DOMAIN }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      client.deleteIdentity({ identity: DOMAIN }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("FakeSesClient configuration sets", () => {
  it("creates, rejects a duplicate, and deletes", async () => {
    const client = fake();
    await client.createConfigurationSet({ configurationSetName: "cs-1" });

    await expect(
      client.createConfigurationSet({ configurationSetName: "cs-1" }),
    ).rejects.toMatchObject({ kind: "already_exists" });

    await client.deleteConfigurationSet({ configurationSetName: "cs-1" });
    await expect(
      client.deleteConfigurationSet({ configurationSetName: "cs-1" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("UPSERTS an event destination rather than throwing on a re-run", async () => {
    const client = fake();
    await client.createConfigurationSet({ configurationSetName: "cs-1" });

    await client.putEventDestination({
      configurationSetName: "cs-1",
      eventDestinationName: "hogsend-sns",
      snsTopicArn: "arn:aws:sns:us-east-1:000000000000:hogsend",
      eventTypes: ["BOUNCE", "COMPLAINT"],
    });
    await client.putEventDestination({
      configurationSetName: "cs-1",
      eventDestinationName: "hogsend-sns",
      snsTopicArn: "arn:aws:sns:us-east-1:000000000000:hogsend",
      eventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY"],
    });

    const destinations = client.__configurationSet("cs-1")?.eventDestinations;
    expect(destinations).toHaveLength(1);
    expect(destinations?.[0]).toMatchObject({
      name: "hogsend-sns",
      enabled: true,
      eventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY"],
    });

    await expect(
      client.putEventDestination({
        configurationSetName: "missing",
        eventDestinationName: "hogsend-sns",
        snsTopicArn: "arn:aws:sns:us-east-1:000000000000:hogsend",
        eventTypes: ["BOUNCE"],
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("FakeSesClient reputation", () => {
  it("records a reputation policy against a live tenant only", async () => {
    const client = await tenantFake();

    await client.setReputationPolicy({ tenantName: TENANT, policy: "STRICT" });
    expect(client.__tenant(TENANT)?.reputationPolicy).toBe("STRICT");

    await expect(
      client.setReputationPolicy({ tenantName: "env-nope", policy: "STRICT" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("pauses and reinstates a tenant through the sending status verb", async () => {
    const client = await sendReadyFake();

    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "tenant_paused" });

    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "REINSTATED",
    });
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).resolves.toBeTruthy();
  });

  it("reports the reputation entity a reconciler reads", async () => {
    const client = await tenantFake();
    const { arn } = await client.getTenant({ tenantName: TENANT });

    await client.setReputationPolicy({ tenantName: TENANT, policy: "STRICT" });
    const healthy = await client.getReputationEntity({ tenantName: TENANT });
    expect(healthy).toMatchObject({
      reference: arn,
      policy: "STRICT",
      sendingStatus: "ENABLED",
    });
    // No operator has written a status, so there is no customer-managed
    // record to report: AWS omits the field until a write exists, and a
    // reconciler asking "has an operator touched this entity?" branches on
    // that presence — a fake that fabricated one would mislead it.
    expect(healthy.customerManagedStatus).toBeUndefined();

    // The whole reason this verb exists: a MISSED EventBridge pause event
    // leaves our mirror saying "active", and the relay reads the mirror — so
    // without a read-back the failure mode is fail-OPEN.
    client.__pauseTenant(TENANT, "high bounce rate");
    const paused = await client.getReputationEntity({ tenantName: TENANT });
    expect(paused.sendingStatus).toBe("DISABLED");
    // And it says WHO paused: AWS's own policy, not an operator of ours —
    // still no customer-managed record, because no operator ever wrote one.
    expect(paused.awsSesManagedStatus).toEqual({
      status: "DISABLED",
      cause: "high bounce rate",
    });
    expect(paused.customerManagedStatus).toBeUndefined();

    // The ARN is accepted too, for a caller that already stored it.
    expect(
      await client.getReputationEntity({ tenantName: TENANT, tenantArn: arn }),
    ).toEqual(paused);

    await expect(
      client.getReputationEntity({ tenantName: "env-nope" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("reports impact and the policy ARN BEFORE any customer write, as AWS does", async () => {
    const client = await tenantFake();
    const { arn } = await client.getTenant({ tenantName: TENANT });
    await client.setReputationPolicy({ tenantName: TENANT, policy: "NONE" });

    const entity = await client.getReputationEntity({ tenantName: TENANT });

    // AWS returns BOTH of these on an untouched entity — observed live on
    // 2026-08-11, where the Fake omitted them entirely. The policy travels as
    // an AWS-owned ARN and `impact` is the entity's reputation impact, which
    // is `NONE` on a healthy tenant.
    expect(entity).toEqual({
      reference: arn,
      sendingStatus: "ENABLED",
      policy: "NONE",
      policyArn: "arn:aws:ses:us-east-1:aws:reputation-policy/none",
      impact: "NONE",
    });
    // And STILL no customer-managed record: AWS omits it until a customer
    // write exists, and PRD 08's enforcement branches on that absence.
    expect(entity.customerManagedStatus).toBeUndefined();
  });

  it("adds the customer-managed record, with AWS's own cause and timestamp, AFTER a write", async () => {
    const client = await tenantFake();

    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });

    const entity = await client.getReputationEntity({ tenantName: TENANT });
    // AWS's literal cause string for a `PutTenantSendingStatus` write, quoted
    // from the live run rather than invented, plus the timestamp it stamps.
    expect(entity.customerManagedStatus).toEqual({
      status: "DISABLED",
      cause: "Status manually updated.",
      lastUpdatedAt: FAKE_SES_CLOCK,
    });
    expect(entity.sendingStatus).toBe("DISABLED");
    // The two fields AWS reports either side of a customer write, unchanged by
    // it: a tenant nobody set a policy on is on `STANDARD`.
    expect(entity.impact).toBe("NONE");
    expect(entity.policyArn).toBe(
      "arn:aws:ses:us-east-1:aws:reputation-policy/standard",
    );
  });

  it("stamps that timestamp from an injectable clock, fixed by default", async () => {
    // The Fake backs the whole control-plane suite, so its default clock is a
    // CONSTANT, never `new Date()`. A test that needs two writes to be
    // distinguishable injects its own; nothing else ever sees wall-clock.
    let tick = 0;
    const client = new FakeSesClient({
      region: "us",
      now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, ++tick)),
    });
    await client.createTenant({ tenantName: TENANT });

    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });
    const first = await client.getReputationEntity({ tenantName: TENANT });
    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "ENABLED",
    });
    const second = await client.getReputationEntity({ tenantName: TENANT });

    expect(first.customerManagedStatus?.lastUpdatedAt).toBe(
      "2030-01-01T00:00:01.000Z",
    );
    expect(second.customerManagedStatus?.lastUpdatedAt).toBe(
      "2030-01-01T00:00:02.000Z",
    );
  });

  it("lists nothing until a recommendation is scripted, then filters", async () => {
    const client = fake();
    expect((await client.listRecommendations()).recommendations).toEqual([]);

    client.__addRecommendation({
      resourceArn: `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`,
      type: "DMARC",
      status: "OPEN",
      impact: "HIGH",
      description: "Publish a DMARC record",
    });
    client.__addRecommendation({
      resourceArn: "arn:aws:ses:us-east-1:000000000000:identity/other.test",
      type: "SPF",
      status: "FIXED",
      impact: "LOW",
    });

    expect((await client.listRecommendations()).recommendations).toHaveLength(
      2,
    );
    expect(
      (await client.listRecommendations({ status: "OPEN" })).recommendations,
    ).toHaveLength(1);
    expect(
      (
        await client.listRecommendations({
          resourceArn: `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`,
        })
      ).recommendations[0]?.type,
    ).toBe("DMARC");
  });
});

describe("FakeSesClient test affordances", () => {
  it("is deterministic: the same script twice yields identical output", async () => {
    const run = async (): Promise<unknown> => {
      const client = fake();
      const tenant = await client.createTenant({ tenantName: TENANT });
      const identity = await client.createIdentity({
        domain: DOMAIN,
        dkim: { selector: "hogsend", privateKey: "PRIVATE" },
      });
      client.__verifyIdentity(DOMAIN);
      await client.associateResource({
        tenantName: TENANT,
        resourceArn: IDENTITY_ARN,
      });
      const sent = await client.sendEmail({
        tenantName: TENANT,
        message: message(),
      });
      return {
        tenant,
        identity,
        sent,
        after: await client.getIdentity({ identity: DOMAIN }),
        log: client.__sent(),
      };
    };

    // No clock, no RNG: byte-identical, which is the property every downstream
    // suite leans on when it asserts an id.
    expect(await run()).toEqual(await run());
  });

  it("scripts exactly one failure with failNext and logs every call", async () => {
    const client = fake();
    client.failNext("createTenant");

    const error = await client
      .createTenant({ tenantName: TENANT })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SesError);
    // Default is RETRYABLE — the interesting case for a caller's backoff.
    expect((error as SesError).retryable).toBe(true);
    expect(client.__tenants()).toHaveLength(0);

    await client.createTenant({ tenantName: TENANT });
    // The FAILED attempt is in the log too, or a retry assertion would be
    // counting only the call that worked.
    expect(client.calls.map((call) => call.method)).toEqual([
      "createTenant",
      "createTenant",
    ]);
  });

  it("drops all state on reset", async () => {
    const client = await sendReadyFake();
    await client.sendEmail({ tenantName: TENANT, message: message() });

    client.reset();

    expect(client.__tenants()).toEqual([]);
    expect(client.__sent()).toEqual([]);
    expect(client.calls).toEqual([]);

    // Identities and associations dropped too: a tenant re-created bare may
    // NOT send until the whole arrangement is redone.
    await client.createTenant({ tenantName: TENANT });
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "invalid" });

    await client.createIdentity({ domain: DOMAIN });
    client.__verifyIdentity(DOMAIN);
    await client.associateResource({
      tenantName: TENANT,
      resourceArn: IDENTITY_ARN,
    });
    // The id counter reset too, so a suite's second test sees message-1 again.
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).resolves.toEqual({ messageId: "fake-ses-message-1" });
  });
});
