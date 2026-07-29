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
  stacks,
} from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import { decryptSecretPayload, encryptSecretPayload } from "../lib/crypto";
import type { EmailSender } from "../lib/email-sender";
import { provisionOrganization } from "../lib/org-provision";
import {
  configureProvisioning,
  enqueueProvision,
  resetProvisioning,
  waitForProvision,
} from "../pipeline/enqueue";
import {
  PROVISION_STEPS,
  type ProvisionStep,
  provisionAuditAction,
  runProvisionPipeline,
} from "../pipeline/provision";
import type { HatchetTenantService } from "../services/hatchet-tenant";
import { ProviderKeyService } from "../services/provider-keys";
import { TenantDbService } from "../services/tenant-db";
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
});

afterAll(async () => {
  resetProvisioning();
  for (const name of createdDatabases) {
    await tenantDb
      .drop({ cellDsn: CLUSTER_DSN, dbName: name, confirm: name })
      .catch(() => {});
  }
  await cleanup();
  await sqlClient.end();
});

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
      credentialsMinted: false,
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
    const created = await provisionOrganization({
      name: `${AUTH_ORG_PREFIX} Auto`,
      region: "us",
      plan: "trial",
      headers,
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
