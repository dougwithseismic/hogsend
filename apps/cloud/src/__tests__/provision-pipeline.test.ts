import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  relayTokens,
  stacks,
} from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import {
  buildEnvironmentUrl,
  PUBLISH_REPLACES_NOTE,
  SCAFFOLD_COMMANDS,
  welcomeEmailSubject,
} from "../lib/cloud-onboarding";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import { provisionOrganization } from "../lib/org-provision";
import {
  configureProvisioning,
  enqueueProvision,
  resetProvisioning,
  waitForProvision,
} from "../pipeline/enqueue";
import {
  emailProviderVars,
  PROVISION_STEPS,
  type ProvisionStep,
  provisionAuditAction,
  runProvisionPipeline,
} from "../pipeline/provision";
import type { HatchetTenantService } from "../services/hatchet-tenant";
import { ProviderKeyService } from "../services/provider-keys";
import { RelayTokenService } from "../services/relay-tokens";
import { getSesWebhookSecret } from "../services/ses-tenants";
import {
  createFakeTenantCredentialClient,
  type TenantCredentialClient,
  TenantCredentialError,
} from "../services/tenant-credentials";
import { TenantDbService } from "../services/tenant-db";
import { getFakeSesClient } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { FakeSubstrate, fakeApiPublicUrl } from "../substrate";
import { SubstrateError } from "../substrate/types";

/**
 * The provisioning pipeline against the REAL control-plane database and the
 * REAL compose Postgres standing in for a cell cluster.
 *
 * What is faked, and why only these two:
 *  - the SUBSTRATE, because that is the seam's whole purpose (and the only way
 *    to script a failure on cue);
 *  - HATCHET TOKEN MINTING, because `hatchet-tenant.test.ts` already proves
 *    that flow against a live engine and this suite must not go red merely
 *    because hatchet-lite is down.
 *
 * Everything else is real: real tenant databases are created on the cluster,
 * real rows transition, real audit rows are written and read back.
 */

/**
 * The cell name sorts FIRST on purpose. `placeOnCell` orders candidates by
 * name, so a leftover cell from another suite must not win placement for the
 * org this file creates through the real signup path.
 */
const CELL_NAME = "aaa-provision-test-us-1";
/** The compose Postgres (docker-compose `postgres`, host port 5434). */
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";
/** Scheme-carrying, so the pipeline treats it as the Hatchet HTTP base. */
const CELL_HATCHET_URL = "http://hatchet.provision.test:8888";

/**
 * A SPLIT-address cell, shaped like the first live one: the Hatchet HTTP API
 * and its gRPC endpoint sit behind two unrelated Railway proxies, so neither
 * address derives from the other.
 */
const SPLIT_CELL_NAME = "aaa-provision-test-split-us-1";
const SPLIT_ORG_ID = "provision-pipeline-split-org";
const SPLIT_HATCHET_API_URL = "https://hatchet-api.provision.test";
const SPLIT_HATCHET_GRPC = "grpc-proxy.provision.test:14108";

const ORG_ID = "provision-pipeline-test-org";
const AUTH_EMAIL = "provision-pipeline@hogsend.test";
const AUTH_PASSWORD = "correct-horse-9";
const AUTH_ORG_PREFIX = "ProvisionPipelineTest";

const tenantDb = new TenantDbService();
const providerKeys = new ProviderKeyService(db);
const auth = createCloudAuth({
  emailSender: { id: "spy", async send() {} } satisfies EmailSender,
});

/** Tenant databases this run created, dropped in `afterAll`. */
const createdDatabases: string[] = [];

/** A minter that never touches the network. Records what it was asked for. */
function stubHatchet(): {
  service: HatchetTenantService;
  calls: Array<{ hatchetUrl: string; tenantSlug: string }>;
} {
  const calls: Array<{ hatchetUrl: string; tenantSlug: string }> = [];
  const service = {
    async mintToken(input: { hatchetUrl: string; tenantSlug: string }) {
      calls.push({
        hatchetUrl: input.hatchetUrl,
        tenantSlug: input.tenantSlug,
      });
      return {
        token: `tok_${input.tenantSlug}`,
        tenantId: randomUUID(),
        tenantSlug: input.tenantSlug,
        createdTenant: true,
        registered: false,
      };
    },
  } as unknown as HatchetTenantService;
  return { service, calls };
}

/** A `TenantDbService` that counts real creates rather than replacing them. */
function countingTenantDb(): {
  service: TenantDbService;
  creates: string[];
  resets: string[];
} {
  const creates: string[] = [];
  const resets: string[] = [];
  const service = {
    async create(input: { cellDsn: string; dbName: string }) {
      creates.push(input.dbName);
      return tenantDb.create(input);
    },
    async resetCredentials(input: { cellDsn: string; dbName: string }) {
      resets.push(input.dbName);
      return tenantDb.resetCredentials(input);
    },
  } as unknown as TenantDbService;
  return { service, creates, resets };
}

interface Fixture {
  stackId: string;
  environmentId: string;
  dbName: string;
}

/** Insert an environment + a `requested` stack, ready to provision. */
async function seedStack(
  kind: "production" | "staging" | "test",
  organizationId: string = ORG_ID,
): Promise<Fixture> {
  const name = `${kind}-${randomBytes(3).toString("hex")}`;
  const [environment] = await db
    .insert(environments)
    .values({ organizationId, name, kind })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  // Unique per stack so a failed run never poisons the next one, and short
  // enough to satisfy TENANT_DB_NAME_RE.
  const dbName = `t_prov_${randomBytes(5).toString("hex")}`;
  createdDatabases.push(dbName);
  await db.insert(stacks).values({
    id: stackId,
    organizationId,
    environmentId: environment.id,
    status: "requested",
    region: "us",
    hatchetNamespace: stackId,
    dbName,
  });

  return { stackId, environmentId: environment.id, dbName };
}

async function environmentRow(environmentId: string) {
  const [row] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!row) throw new Error(`environment ${environmentId} vanished`);
  return row;
}

async function stackRow(stackId: string) {
  const [row] = await db.select().from(stacks).where(eq(stacks.id, stackId));
  if (!row) throw new Error(`stack ${stackId} vanished`);
  return row;
}

/** The provisioning audit actions recorded for a stack, in order. */
async function auditActions(stackId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.subject, stackId))
    .orderBy(cloudAuditLog.createdAt, cloudAuditLog.id);
  return rows.map((row) => row.action);
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${AUTH_ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
    await db.delete(member).where(inArray(member.organizationId, ids));
  }
  await db.delete(user).where(eq(user.email, AUTH_EMAIL));
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [ORG_ID, SPLIT_ORG_ID]));
  await db
    .delete(cells)
    .where(inArray(cells.name, [CELL_NAME, SPLIT_CELL_NAME]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  const [cell] = await db
    .insert(cells)
    .values({
      name: CELL_NAME,
      region: "us",
      sharedClusterDsn: encryptSecretPayload(CLUSTER_DSN),
      sharedHatchetUrl: CELL_HATCHET_URL,
      accepting: true,
      maxTenants: 100,
    })
    .returning();

  await db.insert(organizations).values({
    id: ORG_ID,
    name: "Provision Pipeline Test",
    region: "us",
    plan: "self_serve",
    cellId: cell?.id ?? null,
  });

  const [splitCell] = await db
    .insert(cells)
    .values({
      name: SPLIT_CELL_NAME,
      region: "us",
      sharedClusterDsn: encryptSecretPayload(CLUSTER_DSN),
      // The gRPC endpoint lives in the legacy column; the API base overrides.
      sharedHatchetUrl: SPLIT_HATCHET_GRPC,
      sharedHatchetApiUrl: SPLIT_HATCHET_API_URL,
      accepting: false,
      maxTenants: 100,
    })
    .returning();

  await db.insert(organizations).values({
    id: SPLIT_ORG_ID,
    name: "Provision Pipeline Split Cell",
    region: "us",
    plan: "self_serve",
    cellId: splitCell?.id ?? null,
  });

  await auth.api.signUpEmail({
    body: {
      name: "Provision Pipeline",
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
    },
  });

  // Provisioning reads the org OWNER's email to seed the tenant's Studio admin,
  // so both fixture orgs need a membership row. Named with the suite prefix so
  // `cleanup` sweeps them with everything else.
  const [ownerUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, AUTH_EMAIL));
  if (!ownerUser) throw new Error("fixture owner user missing");
  for (const orgId of [ORG_ID, SPLIT_ORG_ID]) {
    await db
      .insert(organization)
      .values({ id: orgId, name: `${AUTH_ORG_PREFIX} ${orgId}` });
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: ownerUser.id,
      role: "owner",
    });
  }
});

// Dropping one real tenant database per fixture is IO measured in seconds, and
// a CI runner is slower than a laptop: vitest's 10s default hook timeout failed
// this suite in CI while passing locally. The work is teardown, not an
// assertion, so give it room rather than leave orphaned databases behind.
afterAll(async () => {
  resetProvisioning();
  for (const name of createdDatabases) {
    await tenantDb
      .drop({ cellDsn: CLUSTER_DSN, dbName: name, confirm: name })
      .catch(() => {});
  }
  await cleanup();
  await sqlClient.end();
}, 120_000);

describe("runProvisionPipeline", () => {
  it("walks requested → running, audit-logging every step", async () => {
    const fixture = await seedStack("production");
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();

    // Two tenant credentials, to prove the env assembly maps a stored provider
    // payload onto the env names the engine's plugins actually read.
    await providerKeys.store({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "resend",
      payload: { apiKey: "re_test_key", fromEmail: "hello@acme.test" },
    });
    await providerKeys.store({
      organizationId: ORG_ID,
      environmentId: fixture.environmentId,
      provider: "posthog",
      payload: { apiKey: "phc_test", personalApiKey: "phx_test" },
    });

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: hatchet.service, providerKeys },
    );

    expect(result.status).toBe("running");
    expect(result.steps.map((step) => step.step)).toEqual([...PROVISION_STEPS]);

    const row = await stackRow(fixture.stackId);
    expect(row.status).toBe("running");
    expect(row.lastError).toBeNull();
    expect(row.engineVersion).toBe(env.CLOUD_DEFAULT_ENGINE_VERSION);
    expect(row.substrateRefs).toMatchObject({
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      credentialsMinted: true,
    });

    // Every step left a row in the trail — the EARS "with each step
    // audit-logged" read back as data, not inferred from the end state.
    const actions = await auditActions(fixture.stackId);
    for (const step of PROVISION_STEPS) {
      expect(actions).toContain(provisionAuditAction(step));
    }

    // The env that actually reached the substrate.
    const refs = {
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId, region: "us" },
    };
    const applied = substrate.snapshot(refs).env.api;

    const storedDsn = decryptSecretPayload<string>(row.dbDsnEncrypted ?? "");
    expect(applied.DATABASE_URL).toBe(storedDsn);
    expect(applied.DATABASE_URL).toContain(fixture.dbName);
    expect(applied.DATABASE_POOL_MAX).toBe("3");
    expect(applied.API_PUBLIC_URL).toBe(fakeApiPublicUrl(fixture.stackId));
    expect(applied.BETTER_AUTH_URL).toBe(fakeApiPublicUrl(fixture.stackId));
    expect(applied.BETTER_AUTH_SECRET).toEqual(expect.any(String));
    expect(applied.HOGSEND_BOOTSTRAP_API_KEY).toBe("false");
    // The engine's first-admin bootstrap, driven by the control plane: the
    // owner's email, and a password the control plane generated and kept.
    expect(applied.STUDIO_ADMIN_EMAIL).toBe(AUTH_EMAIL);
    const storedSecrets = decryptSecretPayload<{
      studioAdminPassword: string;
      ingestApiKey: string;
    }>(row.stackSecretsEncrypted ?? "");
    expect(applied.STUDIO_ADMIN_PASSWORD).toBe(
      storedSecrets.studioAdminPassword,
    );
    expect(storedSecrets.ingestApiKey).toEqual(expect.any(String));
    expect(applied.HATCHET_CLIENT_TOKEN).toBe(`tok_${fixture.stackId}`);
    expect(applied.HATCHET_CLIENT_HOST_PORT).toBe(
      "hatchet.provision.test:8888",
    );
    expect(applied.HATCHET_CLIENT_NAMESPACE).toBe(fixture.stackId);
    // Provider credentials, under their engine env names.
    expect(applied.RESEND_API_KEY).toBe("re_test_key");
    expect(applied.EMAIL_FROM).toBe("hello@acme.test");
    expect(applied.EMAIL_DOMAIN).toBe("acme.test");
    expect(applied.POSTHOG_API_KEY).toBe("phc_test");
    expect(applied.POSTHOG_PERSONAL_API_KEY).toBe("phx_test");
    // A production stack sends for real; test mode must NOT be forced on.
    expect(applied.HOGSEND_TEST_MODE).toBeUndefined();

    // The minter was pointed at the cell's HTTP base and the stack namespace.
    expect(hatchet.calls).toEqual([
      { hatchetUrl: CELL_HATCHET_URL, tenantSlug: fixture.stackId },
    ]);

    // No secret reached the audit trail.
    const details = await db
      .select({ detail: cloudAuditLog.detail })
      .from(cloudAuditLog)
      .where(eq(cloudAuditLog.subject, fixture.stackId));
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain("re_test_key");
    expect(serialized).not.toContain(storedDsn);
    expect(serialized).not.toContain(applied.BETTER_AUTH_SECRET);
  });

  it("mints the SES tenant one step before set-env, and injects its credentials", async () => {
    // Position is FORCED, not stylistic: `set-env` is what hands the instance
    // its environment, so the relay token has to exist before it runs or the
    // instance boots without one.
    expect(PROVISION_STEPS.indexOf("provision-ses")).toBe(
      PROVISION_STEPS.indexOf("set-env") - 1,
    );

    const fixture = await seedStack("production");
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: hatchet.service },
    );
    expect(result.status).toBe("running");

    const ses = getFakeSesClient("us");
    const tenant = ses.__tenant(sesTenantName(fixture.environmentId));
    expect(tenant).toBeDefined();
    // The line this whole PRD turns on — on the ACCOUNT, one tenant's hard
    // bounce suppresses that address for every other tenant.
    expect(tenant?.suppressionScope).toBe("TENANT");
    expect(tenant?.reputationPolicy).toBe("NONE");
    expect(
      ses.__configurationSet(sesConfigurationSetName(fixture.environmentId)),
    ).toBeDefined();

    const refs = {
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId, region: "us" },
    };
    const applied = substrate.snapshot(refs).env.api;

    // The token the INSTANCE holds is the one the RELAY accepts. Asserting the
    // variable is merely present would pass for a token nothing verifies.
    expect(
      await new RelayTokenService(db).verify({
        token: applied.HOGSEND_EMAIL_TOKEN ?? "",
      }),
    ).toMatchObject({ found: true, environmentId: fixture.environmentId });
    expect(applied.HOGSEND_EMAIL_RELAY_URL).toBe(env.CLOUD_PUBLIC_URL);
    expect(applied.HOGSEND_EMAIL_WEBHOOK_SECRET).toBe(
      await getSesWebhookSecret({ environmentId: fixture.environmentId }),
    );
    // NOT set, because this fixture provisions against the Fake, so the SES
    // tenancy is recorded unavailable. Activating over the Fake would make
    // every send "succeed" against an in-memory client while no mail ever
    // left. See `emailProviderVars`, which is unit-tested both ways.
    expect(applied.EMAIL_PROVIDER).toBeUndefined();

    // Neither credential reached the audit trail.
    const details = await db
      .select({ detail: cloudAuditLog.detail })
      .from(cloudAuditLog)
      .where(eq(cloudAuditLog.subject, fixture.stackId));
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain(applied.HOGSEND_EMAIL_TOKEN);
    expect(serialized).not.toContain(applied.HOGSEND_EMAIL_WEBHOOK_SECRET);
  });

  it("starts the app services only after their env exists, worker first", async () => {
    const fixture = await seedStack("production");
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();

    await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: hatchet.service, providerKeys },
    );

    const order = substrate.calls
      .map((call) => call.method)
      .filter(
        (method) =>
          method === "provisionStack" ||
          method === "setEnv" ||
          method === "deployImage",
      );
    // provisionStack creates the services idle; setEnv gives them a
    // DATABASE_URL; ONLY THEN does anything start. Any deploy before that
    // setEnv boots the engine against nothing and crash-loops — which is what
    // every provision did until 2026-08-04.
    expect(order).toEqual([
      "provisionStack",
      "setEnv",
      "deployImage",
      "deployImage",
    ]);

    // Worker before api: the worker registers its journey tasks with Hatchet on
    // boot, so an api that came up first would accept work nothing could run.
    const deployed = substrate.calls
      .filter((call) => call.method === "deployImage")
      .map((call) => (call.args[1] as { service: string }).service);
    expect(deployed).toEqual(["worker", "api"]);
  });

  it("forces test mode on non-production environments only", async () => {
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: stubHatchet().service },
    );
    expect(result.status).toBe("running");

    const applied = substrate.snapshot({
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId },
    }).env.worker;
    expect(applied.HOGSEND_TEST_MODE).toBe("true");
  });

  it("mints against the cell's API url while the stack gets its gRPC host:port", async () => {
    const fixture = await seedStack("production", SPLIT_ORG_ID);
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: hatchet.service },
    );
    expect(result.status).toBe("running");

    // The two addresses go to two different places: no derivation could have
    // produced one from the other, which is the whole point of the column.
    expect(hatchet.calls).toEqual([
      { hatchetUrl: SPLIT_HATCHET_API_URL, tenantSlug: fixture.stackId },
    ]);
    const applied = substrate.snapshot({
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId },
    }).env.api;
    expect(applied.HATCHET_CLIENT_HOST_PORT).toBe(SPLIT_HATCHET_GRPC);
  });

  it("keeps the legacy single-address derivation for a cell with no api url", async () => {
    // Same cell, override cleared and the legacy column holding a BARE
    // host:port — the derivation the scheme-carrying fixture never exercises.
    await db
      .update(cells)
      .set({
        sharedHatchetUrl: "hatchet-legacy.provision.test:7077",
        sharedHatchetApiUrl: null,
      })
      .where(eq(cells.name, SPLIT_CELL_NAME));

    const fixture = await seedStack("production", SPLIT_ORG_ID);
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { substrate, hatchetTenant: hatchet.service },
    );
    expect(result.status).toBe("running");

    expect(hatchet.calls).toEqual([
      {
        hatchetUrl: "http://hatchet-legacy.provision.test:7077",
        tenantSlug: fixture.stackId,
      },
    ]);
    const applied = substrate.snapshot({
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId },
    }).env.api;
    expect(applied.HATCHET_CLIENT_HOST_PORT).toBe(
      "hatchet-legacy.provision.test:7077",
    );
  });

  it("parks the stack in error naming the failed step, then RESUMES on retry", async () => {
    const fixture = await seedStack("test");
    const substrate = new FakeSubstrate();
    const tenant = countingTenantDb();
    const hatchet = stubHatchet();
    const deps = {
      substrate,
      hatchetTenant: hatchet.service,
      tenantDb: tenant.service,
    };

    // Permanent, so the failure is the pipeline's to record rather than
    // something a substrate-level retry would paper over.
    substrate.failNext(
      "provisionStack",
      new SubstrateError("scripted permanent failure", { retryable: false }),
    );

    const failed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(failed.status).toBe("error");
    if (failed.status !== "error") throw new Error("unreachable");
    expect(failed.failedStep).toBe<ProvisionStep>("substrate-provision");

    const errored = await stackRow(fixture.stackId);
    expect(errored.status).toBe("error");
    expect(errored.lastError).toContain("substrate-provision");
    expect(errored.retryCount).toBe(1);
    // The steps that DID complete left their artifacts behind — that is what
    // makes the retry a resume.
    expect(errored.dbDsnEncrypted).not.toBeNull();
    expect(errored.hatchetTokenEncrypted).not.toBeNull();
    expect(errored.substrateRefs).toEqual({});

    const dsnAfterFailure = errored.dbDsnEncrypted;

    // The retry: same pipeline, same stack, no operator surgery.
    const resumed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(resumed.status).toBe("running");

    // Resumed, not restarted: the completed steps report `skipped`.
    const skipped = resumed.steps
      .filter((step) => step.skipped)
      .map((step) => step.step);
    expect(skipped).toContain("ensure-tenant-db");
    expect(skipped).toContain("mint-hatchet");

    // And the side effects were not duplicated.
    expect(tenant.creates).toHaveLength(1);
    expect(tenant.resets).toHaveLength(0);
    expect(hatchet.calls).toHaveLength(1);
    // Exactly ONE provisionStack after the failed attempt.
    expect(
      substrate.calls.filter((call) => call.method === "provisionStack"),
    ).toHaveLength(2);

    const finished = await stackRow(fixture.stackId);
    expect(finished.status).toBe("running");
    expect(finished.lastError).toBeNull();
    // The credential a running stack holds is the one from the FIRST create.
    expect(finished.dbDsnEncrypted).toBe(dsnAfterFailure);
    // Reaching `running` resets the attempt counter.
    expect(finished.retryCount).toBe(0);
  });

  it("keeps the relay token the instance HOLDS and the one the relay ACCEPTS in lockstep across a resume", async () => {
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();
    const hatchet = stubHatchet();
    const deps = { substrate, hatchetTenant: hatchet.service };

    // Park AFTER `set-env`, so the first run really did inject a token.
    substrate.failNext(
      "deployImage",
      new SubstrateError("scripted permanent failure", { retryable: false }),
    );
    const failed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(failed.status).toBe("error");

    const refs = {
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(fixture.stackId),
      data: { stackId: fixture.stackId, region: "us" },
    };
    const first = substrate.snapshot(refs).env.api;
    const firstSecret = await getSesWebhookSecret({
      environmentId: fixture.environmentId,
    });

    const resumed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(resumed.status).toBe("running");

    const second = substrate.snapshot(refs).env.api;
    const service = new RelayTokenService(db);
    // Only the token's HASH is stored, so a re-drive has nothing to replay and
    // must issue a new one. What must NEVER happen is the two coming apart:
    // the instance holding a token the relay no longer accepts.
    expect(second.HOGSEND_EMAIL_TOKEN).not.toBe(first.HOGSEND_EMAIL_TOKEN);
    expect(
      await service.verify({ token: second.HOGSEND_EMAIL_TOKEN ?? "" }),
    ).toMatchObject({ found: true, environmentId: fixture.environmentId });
    expect(
      await service.verify({ token: first.HOGSEND_EMAIL_TOKEN ?? "" }),
    ).toEqual({ found: false });
    // Exactly one live token, whatever the attempt count.
    expect(
      await db
        .select()
        .from(relayTokens)
        .where(eq(relayTokens.environmentId, fixture.environmentId)),
    ).toHaveLength(1);

    // The webhook secret is the other half of the pair and does NOT rotate:
    // the control plane signs deliveries with it, and a re-drive that changed
    // it would break every delivery until the next env push landed.
    expect(second.HOGSEND_EMAIL_WEBHOOK_SECRET).toBe(firstSecret);

    // One tenant, one configuration set, still tenant-scoped suppression.
    const ses = getFakeSesClient("us");
    expect(
      ses
        .__tenants()
        .filter((row) => row.name === sesTenantName(fixture.environmentId)),
    ).toHaveLength(1);
    expect(
      ses.__tenant(sesTenantName(fixture.environmentId))?.suppressionScope,
    ).toBe("TENANT");
  });

  it("re-uses the substrate stack when a LATER step failed", async () => {
    // The skip that matters most: a retry after `set-env` must not provision a
    // second stack (real money, and an orphan nobody would ever destroy).
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();
    const deps = { substrate, hatchetTenant: stubHatchet().service };

    substrate.failNext(
      "setEnv",
      new SubstrateError("scripted set-env failure", { retryable: false }),
    );

    const failed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(failed.status).toBe("error");
    if (failed.status !== "error") throw new Error("unreachable");
    expect(failed.failedStep).toBe<ProvisionStep>("set-env");

    const resumed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(resumed.status).toBe("running");
    expect(
      resumed.steps.find((step) => step.step === "substrate-provision")
        ?.skipped,
    ).toBe(true);
    expect(
      substrate.calls.filter((call) => call.method === "provisionStack"),
    ).toHaveLength(1);
  });

  it("is a no-op for a stack that is already running", async () => {
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();
    const deps = { substrate, hatchetTenant: stubHatchet().service };

    await runProvisionPipeline({ stackId: fixture.stackId }, deps);
    const again = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );

    expect(again.status).toBe("running");
    expect(again.steps).toEqual([]);
    expect(
      substrate.calls.filter((call) => call.method === "provisionStack"),
    ).toHaveLength(1);
  });
});

describe("mint-credentials", () => {
  /**
   * A credential client that records every call and can be scripted to fail,
   * over the same in-memory key store the fake client uses. The whole point of
   * this step is what a SECOND run does with what a first run left behind, so
   * the store outlives the run and the assertions are about its contents.
   */
  function scriptedClient() {
    const inner = createFakeTenantCredentialClient();
    const calls: string[] = [];
    let failCreate = false;
    let failPersistAfterCreate = false;
    const client: TenantCredentialClient = {
      async signIn(args) {
        calls.push("signIn");
        return inner.signIn(args);
      },
      async listKeys(args) {
        calls.push("listKeys");
        return inner.listKeys(args);
      },
      async createKey(args) {
        calls.push("createKey");
        // Refused outright: nothing is minted, so there is no orphan either.
        if (failCreate) throw new Error("scripted create failure");
        const created = await inner.createKey(args);
        if (failPersistAfterCreate) {
          // The key is LIVE on the instance and the control plane is about to
          // lose it — exactly the orphan the retry has to recognise.
          throw new Error("scripted persist failure");
        }
        return created;
      },
      async revokeKey(args) {
        calls.push(`revokeKey:${args.keyId}`);
        return inner.revokeKey(args);
      },
    };
    return {
      client,
      calls,
      liveKeys: (baseUrl: string) =>
        inner.listKeys({ baseUrl, session: { cookie: "" } }),
      failCreate: (value: boolean) => {
        failCreate = value;
      },
      failPersistAfterCreate: (value: boolean) => {
        failPersistAfterCreate = value;
      },
    };
  }

  it("rides out the container swap instead of parking the stack", async () => {
    // `set-env` restarts the instance, so this step can arrive while the
    // substrate is still swapping containers and nothing answers yet.
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    let refusals = 2;
    const flaky: TenantCredentialClient = {
      ...scripted.client,
      async signIn(args) {
        if (refusals > 0) {
          refusals -= 1;
          throw new TenantCredentialError(
            "Studio sign-in failed with HTTP 503",
            503,
          );
        }
        return scripted.client.signIn(args);
      },
    };

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      {
        substrate: new FakeSubstrate(),
        hatchetTenant: stubHatchet().service,
        tenantCredentials: flaky,
        sleep: async () => {},
      },
    );

    expect(result.status).toBe("running");
    expect(refusals).toBe(0);
  });

  it("waits out the whole rate-limit window on a 429", async () => {
    // The tenant limits /sign-in/email to 10 per 60s. A 429 means the bucket
    // is spent — a short doubling retry would keep re-burning it (and, while
    // all callers shared one bucket, extend the customer's own lockout). The
    // retry must sleep past the 60s window instead.
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    const sleeps: number[] = [];
    let refusals = 1;
    const limited: TenantCredentialClient = {
      ...scripted.client,
      async signIn(args) {
        if (refusals > 0) {
          refusals -= 1;
          throw new TenantCredentialError(
            "Studio sign-in failed with HTTP 429",
            429,
          );
        }
        return scripted.client.signIn(args);
      },
    };

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      {
        substrate: new FakeSubstrate(),
        hatchetTenant: stubHatchet().service,
        tenantCredentials: limited,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result.status).toBe("running");
    expect(refusals).toBe(0);
    // Longer than the tenant's 60s sign-in window, not the 1s doubling step.
    expect(sleeps).toEqual([65_000]);
  });

  it("still parks the stack when the instance itself refuses", async () => {
    // 401 (wrong password) and 403 (Better Auth's CSRF guard) are the
    // instance's own considered answers, not the moment's. Re-driving either
    // is futile, so the retry must not swallow them.
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    const rejecting: TenantCredentialClient = {
      ...scripted.client,
      async signIn() {
        throw new TenantCredentialError(
          "Studio sign-in failed with HTTP 401",
          401,
        );
      },
    };

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      {
        substrate: new FakeSubstrate(),
        hatchetTenant: stubHatchet().service,
        tenantCredentials: rejecting,
        sleep: async () => {},
      },
    );

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ failedStep: "mint-credentials" });
  });

  it("run twice leaves exactly one live key and one stored key", async () => {
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    const deps = {
      substrate: new FakeSubstrate(),
      hatchetTenant: stubHatchet().service,
      tenantCredentials: scripted.client,
    };

    const first = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(first.status).toBe("running");
    const afterFirst = await stackRow(fixture.stackId);
    const firstKey = decryptSecretPayload<{ ingestApiKey: string }>(
      afterFirst.stackSecretsEncrypted ?? "",
    ).ingestApiKey;

    // A `running` stack short-circuits at `start`, so the honest second run is
    // the sweep's: park it, then re-drive the whole pipeline.
    await db
      .update(stacks)
      .set({ status: "error", lastError: "[mint-credentials] forced" })
      .where(eq(stacks.id, fixture.stackId));

    const second = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(second.status).toBe("running");

    const live = await scripted.liveKeys(fakeApiPublicUrl(fixture.stackId));
    expect(live).toHaveLength(1);
    const afterSecond = await stackRow(fixture.stackId);
    const stored = decryptSecretPayload<{ ingestApiKey: string }>(
      afterSecond.stackSecretsEncrypted ?? "",
    );
    // Not rotated: the customer may already be sending with the first key.
    expect(stored.ingestApiKey).toBe(firstKey);
    expect(scripted.calls.filter((call) => call === "createKey")).toHaveLength(
      1,
    );
    expect(afterSecond.substrateRefs).toMatchObject({
      credentialsMinted: true,
    });
  });

  it("revokes the orphan when the store write failed, then re-mints", async () => {
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    const deps = {
      substrate: new FakeSubstrate(),
      hatchetTenant: stubHatchet().service,
      tenantCredentials: scripted.client,
    };

    scripted.failPersistAfterCreate(true);
    const failed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(failed.status).toBe("error");
    if (failed.status !== "error") throw new Error("unreachable");
    expect(failed.failedStep).toBe("mint-credentials");

    // Parked, never `running`: the customer is not told a keyless stack is
    // ready, and the sweep's first condition picks this up.
    const parked = await stackRow(fixture.stackId);
    expect(parked.status).toBe("error");
    expect(parked.substrateRefs).not.toMatchObject({ credentialsMinted: true });
    const orphan = (
      await scripted.liveKeys(fakeApiPublicUrl(fixture.stackId))
    )[0];
    expect(orphan).toBeDefined();

    scripted.failPersistAfterCreate(false);
    const resumed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(resumed.status).toBe("running");

    // The credential nobody held is dead, and its replacement is stored.
    expect(scripted.calls).toContain(`revokeKey:${orphan?.id}`);
    const live = await scripted.liveKeys(fakeApiPublicUrl(fixture.stackId));
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(orphan?.id);
    const stored = decryptSecretPayload<{ ingestApiKeyId: string }>(
      (await stackRow(fixture.stackId)).stackSecretsEncrypted ?? "",
    );
    expect(stored.ingestApiKeyId).toBe(live[0]?.id);
  });

  it("parks the stack when the instance refuses, leaving no live key", async () => {
    const fixture = await seedStack("production");
    const scripted = scriptedClient();
    scripted.failCreate(true);

    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      {
        substrate: new FakeSubstrate(),
        hatchetTenant: stubHatchet().service,
        tenantCredentials: scripted.client,
      },
    );

    expect(result.status).toBe("error");
    const row = await stackRow(fixture.stackId);
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("mint-credentials");
    expect(
      await scripted.liveKeys(fakeApiPublicUrl(fixture.stackId)),
    ).toHaveLength(0);
  });
});

/**
 * The welcome email (PRD 13 T5). It exists to tell a web-first signup — one who
 * has an instance but no repo — what to run, so the assertions are about WHEN
 * it is sent and WHAT it says, not that a send happened.
 */
describe("welcome email", () => {
  function recordingSender(opts: { fail?: boolean } = {}): {
    sender: EmailSender;
    sent: EmailMessage[];
  } {
    const sent: EmailMessage[] = [];
    return {
      sent,
      sender: {
        id: "recording",
        async send(message) {
          if (opts.fail) throw new Error("scripted transport failure");
          sent.push(message);
        },
      },
    };
  }

  it("reaches the owner once the stack is really running, and only once", async () => {
    const fixture = await seedStack("production");
    const mail = recordingSender();
    const deps = {
      substrate: new FakeSubstrate(),
      hatchetTenant: stubHatchet().service,
      emailSender: mail.sender,
    };

    const first = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(first.status).toBe("running");

    expect(mail.sent).toHaveLength(1);
    const message = mail.sent[0];
    if (!message) throw new Error("unreachable");
    expect(message.to).toBe(AUTH_EMAIL);
    expect(message.subject).toBe(
      welcomeEmailSubject({
        organizationName: "Provision Pipeline Test",
        environmentName: (await environmentRow(fixture.environmentId)).name,
        environmentId: fixture.environmentId,
      }),
    );
    // The four commands and the link to THIS environment — the whole point of
    // the mail. A change that drops either is a customer who cannot start.
    for (const command of SCAFFOLD_COMMANDS) {
      expect(message.text).toContain(command);
    }
    expect(message.text).toContain(buildEnvironmentUrl(fixture.environmentId));
    // The non-obvious fact: they already have an instance.
    expect(message.text).toContain(PUBLISH_REPLACES_NOTE);

    const afterFirst = await stackRow(fixture.stackId);
    expect(afterFirst.substrateRefs).toMatchObject({
      credentialsMinted: true,
    });
    expect(
      (afterFirst.substrateRefs as { welcomeEmailSentAt?: string })
        .welcomeEmailSentAt,
    ).toEqual(expect.any(String));

    // Park it and re-drive, the way the provision sweep would. A resumed stack
    // must not welcome the same customer twice.
    await db
      .update(stacks)
      .set({ status: "error", lastError: "[finish] forced" })
      .where(eq(stacks.id, fixture.stackId));
    const second = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(second.status).toBe("running");
    expect(mail.sent).toHaveLength(1);
  });

  it("is not sent before the instance is running, and a dead transport does not park the stack", async () => {
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();
    const mail = recordingSender();
    const deps = {
      substrate,
      hatchetTenant: stubHatchet().service,
      emailSender: mail.sender,
    };

    substrate.failNext(
      "setEnv",
      new SubstrateError("scripted set-env failure", { retryable: false }),
    );
    const failed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      deps,
    );
    expect(failed.status).toBe("error");
    // Nothing promising a running instance left the building while it is
    // parked at `error`.
    expect(mail.sent).toHaveLength(0);

    const dead = recordingSender({ fail: true });
    const resumed = await runProvisionPipeline(
      { stackId: fixture.stackId },
      { ...deps, emailSender: dead.sender },
    );
    // The stack IS running; a mail transport being down is not grounds to say
    // otherwise, and the unsent mail is not recorded as sent.
    expect(resumed.status).toBe("running");
    const row = await stackRow(fixture.stackId);
    expect(row.status).toBe("running");
    expect(
      (row.substrateRefs as { welcomeEmailSentAt?: string }).welcomeEmailSentAt,
    ).toBeUndefined();
  });

  it("still reports running when the send AND the marker write both fail", async () => {
    const fixture = await seedStack("production");
    const mail = recordingSender();

    // The marker leg failing AFTER a successful send is the dangerous shape:
    // inside the pipeline's try it would reach `recordError` with step
    // `finish`, and `running` is not a failable status — so `recordError`
    // would itself throw `IllegalTransitionError` and take the whole provision
    // task down for a customer whose instance is perfectly healthy.
    let sent = false;
    const wall = Date.now();
    const result = await runProvisionPipeline(
      { stackId: fixture.stackId },
      {
        substrate: new FakeSubstrate(),
        hatchetTenant: stubHatchet().service,
        emailSender: {
          id: "recording-then-broken",
          async send(message) {
            mail.sent.push(message);
            sent = true;
          },
        },
        // Read once by the marker write, and only then. Everything earlier
        // (the health wait) gets a real clock.
        now: () => {
          if (sent) throw new Error("scripted clock failure");
          return wall;
        },
      },
    );

    // The status, not merely the absence of a rejection.
    expect(result.status).toBe("running");
    expect(mail.sent).toHaveLength(1);
    const row = await stackRow(fixture.stackId);
    expect(row.status).toBe("running");
    expect(row.lastError).toBeNull();
    // Unmarked — and harmless, because a `running` stack short-circuits at
    // `start` and never reaches the send a second time.
    expect(
      (row.substrateRefs as { welcomeEmailSentAt?: string }).welcomeEmailSentAt,
    ).toBeUndefined();
  });
});

describe("enqueueProvision", () => {
  it("runs a stack in-process under the fake substrate, once per stack", async () => {
    const fixture = await seedStack("staging");
    const substrate = new FakeSubstrate();
    configureProvisioning({
      substrate,
      hatchetTenant: stubHatchet().service,
    });

    // Two enqueues, no await between them: the second must JOIN the first.
    const [first, second] = await Promise.all([
      enqueueProvision(fixture.stackId),
      enqueueProvision(fixture.stackId),
    ]);
    expect(first.mode).toBe("inline");
    expect(second.mode).toBe("joined");

    const result = await waitForProvision(fixture.stackId);
    expect(result?.status).toBe("running");
    // Single-flight proven at the substrate: one run, not two.
    expect(
      substrate.calls.filter((call) => call.method === "provisionStack"),
    ).toHaveLength(1);
    resetProvisioning();
  });
});

describe("organization creation", () => {
  it("provisions the new org's stack to running with no operator action", async () => {
    const response = await auth.api.signInEmail({
      body: { email: AUTH_EMAIL, password: AUTH_PASSWORD },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const headers = new Headers({ cookie });

    const substrate = new FakeSubstrate();
    configureProvisioning({
      substrate,
      hatchetTenant: stubHatchet().service,
    });

    // The REAL path a signup takes — no enqueue injected here, so the default
    // (the module the create-org action calls) is what runs.
    //
    // `provision: true` pins the `CLOUD_PROVISION_ON=signup` policy: this case
    // is about provisioning happening with NO OPERATOR ACTION, which is only a
    // claim about the signup policy. Under the deployment default
    // (`first-publish`) the stack is deliberately born `deferred` and the
    // publish intake is what starts it — asserted in `deferred-provision`.
    const created = await provisionOrganization({
      name: `${AUTH_ORG_PREFIX} Auto`,
      region: "us",
      plan: "trial",
      headers,
      provision: true,
    });

    const [row] = await db
      .select({ dbName: stacks.dbName })
      .from(stacks)
      .where(eq(stacks.id, created.stackId));
    if (row?.dbName) createdDatabases.push(row.dbName);

    const result = await waitForProvision(created.stackId);
    expect(result?.status).toBe("running");

    const stack = await stackRow(created.stackId);
    expect(stack.status).toBe("running");
    expect(stack.substrateRefs).toMatchObject({ substrate: "fake" });

    const actions = await auditActions(created.stackId);
    for (const step of PROVISION_STEPS) {
      expect(actions).toContain(provisionAuditAction(step));
    }
    resetProvisioning();
  });
});

describe("emailProviderVars", () => {
  it("activates Hogsend Email only when the SES tenancy is REAL", () => {
    // The whole point of the branch: `available` is false exactly when the SES
    // factory yielded the Fake. Activating there would be silent
    // non-delivery — every send succeeding against an in-memory client while
    // no mail ever leaves — which is worse than a loud failure precisely
    // because nobody notices it.
    expect(emailProviderVars(true)).toEqual({ EMAIL_PROVIDER: "hogsend" });
    expect(emailProviderVars(false)).toEqual({});
  });
});
