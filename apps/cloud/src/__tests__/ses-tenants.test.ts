import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CloudDb } from "../db";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cloudAuditLog,
  environments,
  organizations,
  relayTokens,
  sesTenants,
} from "../db/schema";
import { env } from "../env";
import { decryptSecretPayload } from "../lib/crypto";
import { RelayTokenService } from "../services/relay-tokens";
import {
  deprovisionSesTenant,
  getSesTenant,
  provisionSesTenant,
  SES_EVENT_DESTINATION_NAME,
  SES_PROVISION_STEPS,
  SES_PUBLISHED_EVENT_TYPES,
  type SesProvisionStep,
} from "../services/ses-tenants";
import type { SesClient } from "../ses/contract";
import { FakeSesClient } from "../ses/fake";
import { getFakeSesClient, getSesClient, resetSesClients } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { WALKTHROUGH_PUBLISHED_EVENT_TYPES } from "../ses-walkthrough/walkthrough";

/**
 * SES tenant provisioning (PRD 06), against the deterministic Fake. Nothing
 * here reaches AWS.
 *
 * The properties under test are the ones whose failure is INVISIBLE:
 *  - `SuppressionScope: TENANT`, addressed by TENANT NAME. Set on the account
 *    instead, one customer's hard bounce suppresses that address for every
 *    other customer — a deliverability bug and a cross-tenant leak at once,
 *    with no symptom until it leaks;
 *  - convergence after a failure at EVERY step, with no duplicated resource. A
 *    provision that half-ran and then minted a second tenant would show up as
 *    an AWS bill and a reputation nobody is watching;
 *  - teardown ORDER. The Fake does not model "a configuration set cannot be
 *    deleted while it is associated", so a wrong order passes every state
 *    assertion and fails on the first real teardown — the order is therefore
 *    asserted from the call log, not inferred from the end state.
 */

const US_ORG = "ses-tenant-test-org-us";
const EU_ORG = "ses-tenant-test-org-eu";

/**
 * The region's SNS topic (PRD 05). Passed EXPLICITLY rather than read from the
 * environment, because `put-event-destination` is the one conditional step:
 * with no topic configured it is skipped, and the tests need to drive both
 * sides of that.
 */
const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:hogsend-email-events-us";

/** What runs when no SNS topic is configured — everything but the destination. */
const STEPS_WITHOUT_TOPIC = SES_PROVISION_STEPS.filter(
  (step) => step !== "put-event-destination",
);

let seq = 0;

async function seedEnvironment(organizationId = US_ORG): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({
      organizationId,
      name: `ses-tenant-env-${seq}`,
      kind: "test",
    })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

async function tenantRow(environmentId: string) {
  const [row] = await db
    .select()
    .from(sesTenants)
    .where(eq(sesTenants.environmentId, environmentId));
  return row;
}

async function tokenRows(environmentId: string) {
  return db
    .select()
    .from(relayTokens)
    .where(eq(relayTokens.environmentId, environmentId));
}

function fake(): FakeSesClient {
  return getFakeSesClient("us");
}

/** The Fake, wearing the AWS client's id — the only thing `available` reads. */
function asAwsClient(client: SesClient): SesClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "id") return "aws";
      return Reflect.get(target, property, target);
    },
  }) as SesClient;
}

/** A db whose FIRST `transaction` throws: the persist step's injected failure. */
function dbFailingOncePersisting(target: CloudDb): CloudDb {
  let armed = true;
  return new Proxy(target, {
    get(source, property) {
      if (property === "transaction" && armed) {
        armed = false;
        return async () => {
          throw new Error("scripted persist failure");
        };
      }
      return Reflect.get(source, property, source);
    },
  }) as CloudDb;
}

/**
 * How each provisioning step is made to fail. The SES steps are scripted on the
 * Fake; `persist` is the database write, so it is injected through the writer.
 */
const FAILURE_INJECTORS: Record<SesProvisionStep, () => { db?: CloudDb }> = {
  "create-tenant": () => {
    fake().failNext("createTenant");
    return {};
  },
  "create-configuration-set": () => {
    fake().failNext("createConfigurationSet");
    return {};
  },
  "put-event-destination": () => {
    fake().failNext("putEventDestination");
    return {};
  },
  "associate-configuration-set": () => {
    fake().failNext("associateResource");
    return {};
  },
  "put-suppression-scope": () => {
    fake().failNext("putSuppressionScope");
    return {};
  },
  "set-reputation-policy": () => {
    fake().failNext("setReputationPolicy");
    return {};
  },
  persist: () => ({ db: dbFailingOncePersisting(db) }),
};

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [US_ORG, EU_ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values([
    { id: US_ORG, name: "SES Tenant Test US", region: "us" },
    { id: EU_ORG, name: "SES Tenant Test EU", region: "eu" },
  ]);
  resetSesClients();
});

afterAll(async () => {
  await cleanup();
  resetSesClients();
  await sqlClient.end();
});

describe("provisionSesTenant", () => {
  it("creates the tenant, its configuration set and the association", async () => {
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant({ environmentId });

    const tenantName = sesTenantName(environmentId);
    const configurationSetName = sesConfigurationSetName(environmentId);
    expect(result.summary.tenantName).toBe(tenantName);
    expect(result.summary.configurationSetName).toBe(configurationSetName);
    // No topic configured here, so the event destination is SKIPPED and the
    // returned steps say so rather than claiming one was attached.
    expect(result.steps).toEqual([...STEPS_WITHOUT_TOPIC]);

    const tenant = fake().__tenant(tenantName);
    expect(tenant).toBeDefined();
    expect(fake().__configurationSet(configurationSetName)).toBeDefined();
    // The configuration set is ASSOCIATED with the tenant, by ARN, derived
    // from the tenant's own ARN (we never guess an account id).
    expect(tenant?.resources).toEqual([
      `${tenant?.arn.replace(/:tenant\/.*$/, "")}:configuration-set/${configurationSetName}`,
    ]);
  });

  it("attaches the SNS event destination, publishing exactly five event types", async () => {
    // Without a destination the configuration set publishes NOTHING, so no
    // bounce or complaint ever reaches the tenant's engine: suppression never
    // happens and `email_sends` never reaches a terminal status.
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant(
      { environmentId },
      { snsTopicArn: TOPIC_ARN },
    );

    expect(result.steps).toEqual([...SES_PROVISION_STEPS]);

    const set = fake().__configurationSet(
      sesConfigurationSetName(environmentId),
    );
    expect(set?.eventDestinations).toHaveLength(1);
    const destination = set?.eventDestinations[0];
    expect(destination?.name).toBe(SES_EVENT_DESTINATION_NAME);
    expect(destination?.snsTopicArn).toBe(TOPIC_ARN);
    expect(destination?.enabled).toBe(true);
    // FIVE. `OPEN` and `CLICK` are ABSENT by design — opens and clicks are
    // first-party and sovereign, and subscribing to SES's would give the engine
    // two disagreeing sources of truth for one fact. `SEND` is absent because
    // the relay really does already know what it sent. `REJECT` is PRESENT
    // (PRD 18) because it is the one outcome the relay cannot infer: SES
    // accepted the message, returned an id, then discarded it.
    expect([...(destination?.eventTypes ?? [])].sort()).toEqual([
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "DELIVERY_DELAY",
      "REJECT",
    ]);
    expect(destination?.eventTypes).not.toContain("OPEN");
    expect(destination?.eventTypes).not.toContain("CLICK");
    expect(destination?.eventTypes).not.toContain("SEND");
  });

  it("re-asserts the event destination on a re-drive rather than duplicating it", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId }, { snsTopicArn: TOPIC_ARN });
    await provisionSesTenant({ environmentId }, { snsTopicArn: TOPIC_ARN });

    const set = fake().__configurationSet(
      sesConfigurationSetName(environmentId),
    );
    // A PUT, not an append: the seam does the create-then-update dance AWS has
    // no single operation for.
    expect(set?.eventDestinations).toHaveLength(1);
  });

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

  it("adds REJECT to a destination provisioned before PRD 18 existed", async () => {
    // THE back-compat line. Every configuration set already out there carries
    // the OLD four types, and `CreateConfigurationSetEventDestination` fails
    // with `already_exists` on one — so an implementation that only ever
    // CREATED would either duplicate the destination or fail the whole
    // re-drive, and those tenants would never start publishing Reject.
    const environmentId = await seedEnvironment();
    const configurationSetName = sesConfigurationSetName(environmentId);

    // Stand up the pre-PRD-18 world by hand: the set exists and its ONE
    // destination names the old four.
    await fake().createConfigurationSet({ configurationSetName });
    await fake().putEventDestination({
      configurationSetName,
      eventDestinationName: SES_EVENT_DESTINATION_NAME,
      snsTopicArn: TOPIC_ARN,
      eventTypes: ["DELIVERY", "BOUNCE", "COMPLAINT", "DELIVERY_DELAY"],
      enabled: true,
    });

    const result = await provisionSesTenant(
      { environmentId },
      { snsTopicArn: TOPIC_ARN },
    );

    expect(result.steps).toContain("put-event-destination");
    const set = fake().__configurationSet(configurationSetName);
    // Converged, not duplicated.
    expect(set?.eventDestinations).toHaveLength(1);
    expect([...(set?.eventDestinations[0]?.eventTypes ?? [])].sort()).toEqual([
      "BOUNCE",
      "COMPLAINT",
      "DELIVERY",
      "DELIVERY_DELAY",
      "REJECT",
    ]);
  });

  it("skips the event destination — and says so — when no topic is configured", async () => {
    // A control plane with no AWS account is the SUPPORTED default. There is
    // nothing to publish to, and a provision that failed over it would make the
    // no-credentials mode unusable.
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant(
      { environmentId },
      { snsTopicArn: null },
    );

    expect(result.steps).not.toContain("put-event-destination");
    expect(
      fake().__configurationSet(sesConfigurationSetName(environmentId))
        ?.eventDestinations,
    ).toHaveLength(0);
  });

  it("puts the suppression scope on the TENANT, for bounces AND complaints", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });

    const tenantName = sesTenantName(environmentId);
    const tenant = fake().__tenant(tenantName);
    // THE line of this PRD. On the ACCOUNT, one tenant's hard bounce silently
    // suppresses that address for every other tenant.
    expect(tenant?.suppressionScope).toBe("TENANT");
    expect([...(tenant?.suppressedReasons ?? [])].sort()).toEqual([
      "BOUNCE",
      "COMPLAINT",
    ]);

    // Addressed BY TENANT NAME. `PutConfigurationSetSuppressionOptions` is a
    // different operation that cannot set tenant scope at all, so the argument
    // proves which operation was reached for.
    const calls = fake().calls.filter(
      (entry) =>
        entry.method === "putSuppressionScope" &&
        (entry.args[0] as { tenantName?: string }).tenantName === tenantName,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toMatchObject({ tenantName, scope: "TENANT" });
  });

  it("starts a new tenant on reputation policy None — observe, do not enforce", async () => {
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant({ environmentId });

    expect(
      fake().__tenant(sesTenantName(environmentId))?.reputationPolicy,
    ).toBe("NONE");
    expect(result.summary.reputationPolicy).toBe("NONE");
    expect((await tenantRow(environmentId))?.reputationPolicy).toBe("NONE");
  });

  it("mints a relay token whose PLAINTEXT is returned and whose hash alone is stored", async () => {
    const environmentId = await seedEnvironment();
    const { relayToken } = await provisionSesTenant({ environmentId });

    const verified = await new RelayTokenService(db).verify({
      token: relayToken,
    });
    expect(verified).toMatchObject({ found: true, environmentId });

    const rows = await tokenRows(environmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(relayToken);
    expect(JSON.stringify(rows[0])).not.toContain(relayToken);
  });

  it("records the environment's region and pins the AWS region it minted in", async () => {
    const environmentId = await seedEnvironment(EU_ORG);
    const result = await provisionSesTenant({ environmentId });

    expect(result.summary.region).toBe("eu");
    expect(result.summary.awsRegion).toBe("eu-west-1");

    // Minted on the EU client, and NOT on the US one: tenants are
    // region-scoped and do not replicate.
    expect(
      getFakeSesClient("eu").__tenant(sesTenantName(environmentId)),
    ).toBeDefined();
    expect(fake().__tenant(sesTenantName(environmentId))).toBeUndefined();

    const row = await tenantRow(environmentId);
    expect(row?.region).toBe("eu");
    expect(row?.awsRegion).toBe("eu-west-1");
  });

  it("provisions against the Fake with no AWS credentials, and marks it unavailable", async () => {
    // The whole suite runs with neither credential set — the supported default.
    expect(process.env.CLOUD_AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.CLOUD_AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(getSesClient("us")).toBeInstanceOf(FakeSesClient);

    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant({ environmentId });

    // Provisioning SUCCEEDS. Hogsend Email is marked unavailable rather than
    // the provision failing.
    expect(result.summary.available).toBe(false);
    expect((await tenantRow(environmentId))?.available).toBe(false);
  });

  it("marks the tenant available when a real AWS client minted it", async () => {
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant(
      { environmentId },
      { ses: asAwsClient(getSesClient("us")) },
    );

    expect(result.summary.available).toBe(true);
    expect((await tenantRow(environmentId))?.available).toBe(true);
  });

  it("converges after a failure at EVERY step, with no duplicate resources", async () => {
    for (const step of SES_PROVISION_STEPS) {
      const environmentId = await seedEnvironment();
      const tenantName = sesTenantName(environmentId);
      const configurationSetName = sesConfigurationSetName(environmentId);

      const overrides = FAILURE_INJECTORS[step]();
      await expect(
        provisionSesTenant(
          { environmentId },
          { ...overrides, snsTopicArn: TOPIC_ARN },
        ),
      ).rejects.toThrow();

      // The re-drive: same call, nothing else.
      const result = await provisionSesTenant(
        { environmentId },
        { snsTopicArn: TOPIC_ARN },
      );

      const tenant = fake().__tenant(tenantName);
      expect(tenant, `step ${step}`).toBeDefined();
      // ONE association, not one per attempt.
      expect(tenant?.resources, `step ${step}`).toHaveLength(1);
      expect(tenant?.suppressionScope, `step ${step}`).toBe("TENANT");
      expect(tenant?.reputationPolicy, `step ${step}`).toBe("NONE");
      expect(
        fake().__configurationSet(configurationSetName),
        `step ${step}`,
      ).toBeDefined();
      expect(
        fake()
          .__tenants()
          .filter((entry) => entry.name === tenantName),
        `step ${step}`,
      ).toHaveLength(1);

      // Exactly one row of each kind, whatever the attempt count.
      expect(await tokenRows(environmentId), `step ${step}`).toHaveLength(1);
      const rows = await db
        .select()
        .from(sesTenants)
        .where(eq(sesTenants.environmentId, environmentId));
      expect(rows, `step ${step}`).toHaveLength(1);
      expect(result.summary.tenantName, `step ${step}`).toBe(tenantName);
    }
  });

  it("keeps the webhook secret stable across a re-drive, and rotates the relay token", async () => {
    const environmentId = await seedEnvironment();
    const first = await provisionSesTenant({ environmentId });
    const second = await provisionSesTenant({ environmentId });

    // The instance verifies control-plane webhooks with this secret; rotating
    // it on every re-drive would break deliveries for no reason.
    expect(second.webhookSecret).toBe(first.webhookSecret);
    expect(first.relayTokenRotated).toBe(false);
    expect(second.relayTokenRotated).toBe(true);

    // The plaintext token exists exactly once, so a re-drive has nothing to
    // replay and must issue a new one — which `set-env` re-injects.
    expect(second.relayToken).not.toBe(first.relayToken);
    const service = new RelayTokenService(db);
    expect(await service.verify({ token: first.relayToken })).toEqual({
      found: false,
    });
    expect(await service.verify({ token: second.relayToken })).toMatchObject({
      found: true,
      environmentId,
    });
  });

  it("stores the webhook secret encrypted, never in the clear", async () => {
    const environmentId = await seedEnvironment();
    const { webhookSecret } = await provisionSesTenant({ environmentId });

    const row = await tenantRow(environmentId);
    expect(row?.webhookSecretEncrypted).not.toContain(webhookSecret);
    expect(
      decryptSecretPayload<string>(row?.webhookSecretEncrypted ?? ""),
    ).toBe(webhookSecret);
  });

  it("never walks back a promoted reputation policy on a re-drive", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });

    // PRD 08 promotes a tenant that has earned it.
    await db
      .update(sesTenants)
      .set({ reputationPolicy: "STANDARD" })
      .where(eq(sesTenants.environmentId, environmentId));
    fake().setReputationPolicy({
      tenantName: sesTenantName(environmentId),
      policy: "STANDARD",
    });

    const result = await provisionSesTenant({ environmentId });
    expect(result.summary.reputationPolicy).toBe("STANDARD");
    expect(
      fake().__tenant(sesTenantName(environmentId))?.reputationPolicy,
    ).toBe("STANDARD");
    expect((await tenantRow(environmentId))?.reputationPolicy).toBe("STANDARD");
  });

  it("refuses an environment that does not exist", async () => {
    await expect(
      provisionSesTenant({
        environmentId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/Environment/);
  });
});

describe("getSesTenant", () => {
  it("exposes the tenant name, region, configuration set and reputation policy", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });

    const summary = await getSesTenant({ environmentId });
    expect(summary).toMatchObject({
      environmentId,
      tenantName: sesTenantName(environmentId),
      configurationSetName: sesConfigurationSetName(environmentId),
      region: "us",
      awsRegion: "us-east-1",
      reputationPolicy: "NONE",
      available: false,
    });
    // A read surface never carries the signing secret.
    expect(JSON.stringify(summary)).not.toContain("webhookSecret");
  });

  it("answers null for an environment that was never provisioned", async () => {
    const environmentId = await seedEnvironment();
    expect(await getSesTenant({ environmentId })).toBeNull();
  });
});

describe("deprovisionSesTenant", () => {
  it("disassociates BEFORE deleting the tenant, then the configuration set", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });
    const tenantName = sesTenantName(environmentId);
    const configurationSetName = sesConfigurationSetName(environmentId);

    fake().calls.length = 0;
    const result = await deprovisionSesTenant({ environmentId });
    expect(result.found).toBe(true);

    // ORDER, from the call log, because the end state cannot prove it: every
    // resource is gone either way. This pins a CHOSEN order, not an AWS
    // invariant — `DeleteTenant` explicitly removes its own associations and
    // documents no conflict. See `SES_DEPROVISION_STEPS`. It earns its place by
    // catching an accidental reorder, nothing more.
    expect(fake().calls.map((entry) => entry.method)).toEqual([
      "disassociateResource",
      "deleteTenant",
      "deleteConfigurationSet",
    ]);

    expect(fake().__tenant(tenantName)).toBeUndefined();
    expect(fake().__configurationSet(configurationSetName)).toBeUndefined();
    expect(await tokenRows(environmentId)).toHaveLength(0);
    expect(await tenantRow(environmentId)).toBeUndefined();
  });

  it("never writes the relay token or webhook secret to the audit trail", async () => {
    // The provision-pipeline suite has a secret-leak fence, but it queries
    // audit rows by `subject = stackId`. This service keys its own rows on the
    // SES tenant row id and the relay token row id, so they fall OUTSIDE that
    // query — the fence has a gap exactly where the secret is minted. This
    // closes it by scanning EVERY row written during the provision.
    const environmentId = await seedEnvironment();
    const result = await provisionSesTenant({ environmentId });

    // Guard the guard: a `not.toContain` against an empty or undefined needle
    // is the vacuous green this whole stack keeps tripping over. If these ever
    // stop being real secrets, this test must fail LOUDLY rather than pass.
    expect(result.relayToken).toMatch(/^\S{16,}$/);
    expect(result.webhookSecret).toMatch(/^\S{16,}$/);

    const rows = await db.select().from(cloudAuditLog);
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows);

    expect(serialized).not.toContain(result.relayToken);
    expect(serialized).not.toContain(result.webhookSecret);
  });

  it("refuses to tear down a REAL tenant with the fake client", async () => {
    // The leak this guards is reached entirely through steps that look like
    // success. Every teardown step tolerates `not_found` (correct: the goal is
    // an absence), and the fake answers `not_found` for everything it never
    // minted. So a row provisioned against real AWS, torn down after the
    // control plane lost its credentials, would report a clean success and
    // delete the row — leaking the real tenant and configuration set forever,
    // with the only record of them now gone.
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });

    // Mark the row the way a REAL provision would have.
    await db
      .update(sesTenants)
      .set({ available: true })
      .where(eq(sesTenants.environmentId, environmentId));

    await expect(deprovisionSesTenant({ environmentId })).rejects.toThrow(
      /provisioned against AWS/,
    );

    // And it left everything intact, so a re-drive once credentials return
    // still has something to delete.
    expect(await tenantRow(environmentId)).toBeDefined();
    expect(fake().__tenant(sesTenantName(environmentId))).toBeDefined();
  });

  it("tolerates every resource already being absent", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });

    // Somebody deleted them out of band — a half-run teardown, a console.
    await fake().disassociateResource({
      tenantName: sesTenantName(environmentId),
      resourceArn:
        fake().__tenant(sesTenantName(environmentId))?.resources[0] ?? "",
    });
    await fake().deleteTenant({ tenantName: sesTenantName(environmentId) });
    await fake().deleteConfigurationSet({
      configurationSetName: sesConfigurationSetName(environmentId),
    });

    const result = await deprovisionSesTenant({ environmentId });
    expect(result.found).toBe(true);
    expect(await tokenRows(environmentId)).toHaveLength(0);
    expect(await tenantRow(environmentId)).toBeUndefined();
  });

  it("is idempotent: a second teardown touches nothing", async () => {
    const environmentId = await seedEnvironment();
    await provisionSesTenant({ environmentId });
    await deprovisionSesTenant({ environmentId });

    fake().calls.length = 0;
    const result = await deprovisionSesTenant({ environmentId });
    expect(result.found).toBe(false);
    expect(fake().calls).toEqual([]);
  });

  it("leaves the relay token dead the instant the tenant is torn down", async () => {
    const environmentId = await seedEnvironment();
    const { relayToken } = await provisionSesTenant({ environmentId });
    await deprovisionSesTenant({ environmentId });

    expect(
      await new RelayTokenService(db).verify({ token: relayToken }),
    ).toEqual({ found: false });
  });
});
