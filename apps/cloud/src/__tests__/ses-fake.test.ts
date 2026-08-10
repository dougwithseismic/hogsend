import { describe, expect, it } from "vitest";
import { AwsSesClient } from "../ses/aws";
import { resolveSesRegion, SES_VERBS } from "../ses/contract";
import { FAKE_SES_ID, FakeSesClient } from "../ses/fake";
import type { SesMessage } from "../ses/types";
import { SesError } from "../ses/types";

/**
 * The Fake is the whole point of PRD 02: PRDs 03 and 05–09 test against it, so
 * its state machine is the thing under test here, not a convenience.
 *
 * Two properties are asserted relentlessly:
 *  1. DETERMINISM — no clock, no RNG. Two fresh instances driven with the same
 *     inputs produce byte-identical output, which is what lets a downstream
 *     suite assert an id rather than record a sample.
 *  2. REAL TRANSITIONS — an identity is unverified until something verifies it,
 *     a paused tenant refuses to send. A fake that answered "verified" on
 *     creation would let PRD 07 ship a domain flow that never waits.
 */

const TENANT = "env-11111111-1111-4111-8111-111111111111";
const DOMAIN = "acme.test";

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

describe("the SES contract surface", () => {
  it("is exactly NINETEEN verbs, and both implementations answer all of them", () => {
    // A silent drop is the failure this guards: a verb deleted from the
    // interface takes its callers' behaviour with it and nothing else notices,
    // because a Fake that no longer has a method is just a Fake nobody calls.
    expect(SES_VERBS).toHaveLength(19);
    expect(new Set(SES_VERBS).size).toBe(19);

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

  it("returns the EXISTING tenant on a second create", async () => {
    const client = fake();
    const first = await client.createTenant({ tenantName: TENANT });
    const second = await client.createTenant({
      tenantName: TENANT,
      tags: { environment: "production" },
    });

    // Provisioning is resumable: a re-driven step must not throw and must not
    // mint a second tenant.
    expect(second).toEqual(first);
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

  it("associates resources idempotently and refuses an unknown tenant", async () => {
    const client = await tenantFake();
    const resourceArn = `arn:aws:ses:us-east-1:000000000000:identity/${DOMAIN}`;

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
});

describe("FakeSesClient sending", () => {
  it("records the message and issues a deterministic id", async () => {
    const client = await tenantFake();

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

  it("refuses to send on behalf of a tenant that does not exist", async () => {
    await expect(
      fake().sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("fails CLOSED and non-retryably while the tenant is paused", async () => {
    const client = await tenantFake();
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
    const client = await tenantFake();
    client.__pauseAccount();

    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).rejects.toMatchObject({ kind: "account_paused" });
  });

  it("returns one batch result per message, in order, with per-entry failures", async () => {
    const client = await tenantFake();
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
});

describe("FakeSesClient identities", () => {
  it("creates an identity UNVERIFIED, and only an explicit step verifies it", async () => {
    const client = fake();

    const created = await client.createIdentity({
      domain: DOMAIN,
      dkim: { selector: "hogsend", privateKey: "PRIVATE" },
    });

    expect(created.verifiedForSending).toBe(false);
    expect(created.verificationStatus).toBe("PENDING");
    expect(created.dkim).toMatchObject({
      origin: "EXTERNAL",
      status: "PENDING",
      signingEnabled: true,
    });

    client.__verifyIdentity(DOMAIN);
    const verified = await client.getIdentity({ identity: DOMAIN });
    expect(verified.verifiedForSending).toBe(true);
    expect(verified.verificationStatus).toBe("SUCCESS");
    expect(verified.dkim.status).toBe("SUCCESS");
  });

  it("marks Easy DKIM when no BYODKIM key is supplied", async () => {
    const created = await fake().createIdentity({ domain: DOMAIN });
    expect(created.dkim.origin).toBe("AWS_SES");
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
    const client = await tenantFake();

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

    // The whole reason this verb exists: a MISSED EventBridge pause event
    // leaves our mirror saying "active", and the relay reads the mirror — so
    // without a read-back the failure mode is fail-OPEN.
    client.__pauseTenant(TENANT, "high bounce rate");
    const paused = await client.getReputationEntity({ tenantName: TENANT });
    expect(paused.sendingStatus).toBe("DISABLED");
    // And it says WHO paused: AWS's own policy, not an operator of ours.
    expect(paused.awsSesManagedStatus).toEqual({
      status: "DISABLED",
      cause: "high bounce rate",
    });
    expect(paused.customerManagedStatus).toEqual({ status: "ENABLED" });

    // The ARN is accepted too, for a caller that already stored it.
    expect(
      await client.getReputationEntity({ tenantName: TENANT, tenantArn: arn }),
    ).toEqual(paused);

    await expect(
      client.getReputationEntity({ tenantName: "env-nope" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("round-trips an operator pause through the reputation entity", async () => {
    const client = await tenantFake();

    await client.setTenantSendingStatus({
      tenantName: TENANT,
      status: "DISABLED",
    });

    const entity = await client.getReputationEntity({ tenantName: TENANT });
    expect(entity.customerManagedStatus).toEqual({ status: "DISABLED" });
    expect(entity.sendingStatus).toBe("DISABLED");
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
    const client = await tenantFake();
    await client.sendEmail({ tenantName: TENANT, message: message() });

    client.reset();

    expect(client.__tenants()).toEqual([]);
    expect(client.__sent()).toEqual([]);
    expect(client.calls).toEqual([]);
    // The id counter resets too, so a suite's second test sees message-1 again.
    await client.createTenant({ tenantName: TENANT });
    await expect(
      client.sendEmail({ tenantName: TENANT, message: message() }),
    ).resolves.toEqual({ messageId: "fake-ses-message-1" });
  });
});
