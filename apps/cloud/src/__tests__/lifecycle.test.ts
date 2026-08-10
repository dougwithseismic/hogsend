import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import postgres from "postgres";
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
import { encryptSecretPayload } from "../lib/crypto";
import type { EmailSender } from "../lib/email-sender";
import {
  ConfirmationMismatchError,
  destroyEnvironment,
  resumeEnvironment,
  suspendEnvironment,
} from "../lib/environment-ops";
import { NotPermittedError } from "../lib/org-members";
import {
  DESTROY_STEPS,
  destroyAuditAction,
  destroyStack,
  resumeStack,
  suspendStack,
} from "../pipeline/lifecycle";
import { runProvisionPipeline } from "../pipeline/provision";
import { IllegalTransitionError } from "../services/errors";
import type { HatchetTenantService } from "../services/hatchet-tenant";
import { deprovisionSesTenant, getSesTenant } from "../services/ses-tenants";
import { TenantDbService } from "../services/tenant-db";
import { getFakeSesClient } from "../ses/index";
import { sesConfigurationSetName, sesTenantName } from "../ses/names";
import { FakeSubstrate, fakeApiPublicUrl } from "../substrate";
import { SubstrateError } from "../substrate/types";

/**
 * Suspend / resume / destroy against the REAL control-plane database and the
 * REAL compose Postgres standing in for a cell cluster.
 *
 * Only two things are faked, for the same reasons `provision-pipeline.test.ts`
 * fakes them: the SUBSTRATE (the seam's purpose, and the only way to script a
 * failure) and HATCHET TOKEN MINTING (proven elsewhere against a live engine).
 * The tenant databases are REAL — a destroy test that did not check
 * `pg_database` would be asserting an intention rather than an outcome.
 */

const CELL_NAME = "aaa-lifecycle-test-us-1";
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";
const CELL_HATCHET_URL = "http://hatchet.lifecycle.test:8888";

const ORG_ID = "lifecycle-test-org";
const PASSWORD = "correct-horse-11";
const OWNER_EMAIL = "lifecycle-owner@hogsend.test";
const MEMBER_EMAIL = "lifecycle-member@hogsend.test";
const AUTH_ORG_PREFIX = "LifecycleTest";

const tenantDb = new TenantDbService();
const auth = createCloudAuth({
  emailSender: { id: "spy", async send() {} } satisfies EmailSender,
});

const createdDatabases: string[] = [];

function stubHatchet(): HatchetTenantService {
  return {
    async mintToken(input: { hatchetUrl: string; tenantSlug: string }) {
      return {
        token: `tok_${input.tenantSlug}`,
        tenantId: randomUUID(),
        tenantSlug: input.tenantSlug,
        createdTenant: true,
        registered: false,
      };
    },
  } as unknown as HatchetTenantService;
}

interface Fixture {
  stackId: string;
  environmentId: string;
  environmentName: string;
  dbName: string;
  substrate: FakeSubstrate;
  refs: { substrate: string; apiPublicUrl: string; data: { stackId: string } };
}

/** A fully provisioned, `running` stack on a fresh FakeSubstrate. */
async function seedRunningStack(
  organizationId = ORG_ID,
  kind: "production" | "staging" | "test" = "staging",
): Promise<Fixture> {
  const name = `${kind}-${randomBytes(3).toString("hex")}`;
  const [environment] = await db
    .insert(environments)
    .values({ organizationId, name, kind })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const dbName = `t_life_${randomBytes(5).toString("hex")}`;
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

  const substrate = new FakeSubstrate();
  const result = await runProvisionPipeline(
    { stackId },
    { substrate, hatchetTenant: stubHatchet() },
  );
  if (result.status !== "running") {
    throw new Error(`fixture stack did not reach running: ${result.status}`);
  }

  return {
    stackId,
    environmentId: environment.id,
    environmentName: name,
    dbName,
    substrate,
    refs: {
      substrate: "fake",
      apiPublicUrl: fakeApiPublicUrl(stackId),
      data: { stackId },
    },
  };
}

async function stackRow(stackId: string) {
  const [row] = await db.select().from(stacks).where(eq(stacks.id, stackId));
  if (!row) throw new Error(`stack ${stackId} vanished`);
  return row;
}

async function auditActions(stackId: string): Promise<string[]> {
  const rows = await db
    .select({ action: cloudAuditLog.action })
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.subject, stackId))
    .orderBy(cloudAuditLog.createdAt, cloudAuditLog.id);
  return rows.map((row) => row.action);
}

/** Ask the CLUSTER, not the control plane: is the database really gone? */
async function databaseExistsOnCluster(dbName: string): Promise<boolean> {
  const sql = postgres(CLUSTER_DSN, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    return rows.length > 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A `cookie` header carrying a real signed-in session. */
async function signIn(email: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error(`sign-in returned no cookie for ${email}`);
  return new Headers({ cookie });
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${AUTH_ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(member).where(inArray(member.organizationId, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, [OWNER_EMAIL, MEMBER_EMAIL]));
  await db.delete(organizations).where(eq(organizations.id, ORG_ID));
  await db.delete(cells).where(eq(cells.name, CELL_NAME));
}

/** The auth organization the role-gating tests act on, and its cloud mirror. */
let authOrgId = "";

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
  const cellId = cell?.id ?? null;

  await db.insert(organizations).values({
    id: ORG_ID,
    name: "Lifecycle Test",
    region: "us",
    plan: "self_serve",
    cellId,
  });

  // A real Better Auth organization with an owner and a plain member, so the
  // role gate is exercised against real sessions rather than a stubbed role.
  for (const email of [OWNER_EMAIL, MEMBER_EMAIL]) {
    await auth.api.signUpEmail({
      body: { name: email, email, password: PASSWORD },
    });
  }
  const ownerHeaders = await signIn(OWNER_EMAIL);
  const created = await auth.api.createOrganization({
    body: { name: `${AUTH_ORG_PREFIX} Ops`, slug: `lifecycle-${randomUUID()}` },
    headers: ownerHeaders,
  });
  if (!created) throw new Error("fixture organization not created");
  authOrgId = created.id;

  const [memberUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, MEMBER_EMAIL));
  if (!memberUser) throw new Error("fixture member user missing");
  // Inserted directly rather than invite-and-accept: `members.test.ts` already
  // proves that flow end to end, and this suite only needs the ROLE to exist.
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: authOrgId,
    userId: memberUser.id,
    role: "member",
  });

  // The bare `ORG_ID` org needs a membership too: provisioning reads the
  // owner's email to seed the tenant's Studio admin, and refuses without one.
  const [ownerUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, OWNER_EMAIL));
  if (!ownerUser) throw new Error("fixture owner user missing");
  await db
    .insert(organization)
    .values({ id: ORG_ID, name: `${AUTH_ORG_PREFIX} Bare` });
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: ORG_ID,
    userId: ownerUser.id,
    role: "owner",
  });

  // The control-plane mirror the environments hang off. `plan: dedicated`
  // buys enough environment allowance for the several this suite creates.
  await db.insert(organizations).values({
    id: authOrgId,
    name: `${AUTH_ORG_PREFIX} Ops`,
    region: "us",
    plan: "dedicated",
    cellId,
  });
});

// Dropping one real tenant database per fixture is IO measured in seconds, and
// a CI runner is slower than a laptop: vitest's 10s default hook timeout failed
// this suite in CI while passing locally (as it did provision-pipeline's). The
// work is teardown, not an assertion, so give it room rather than leave
// orphaned databases behind.
afterAll(async () => {
  for (const name of createdDatabases) {
    await tenantDb
      .drop({ cellDsn: CLUSTER_DSN, dbName: name, confirm: name })
      .catch(() => {});
  }
  await cleanup();
  await sqlClient.end();
}, 120_000);

describe("suspendStack / resumeStack", () => {
  it("suspends a running stack, reports unhealthy, then resumes it healthy", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };

    // Healthy while running — the baseline the rest of this test moves from.
    await expect(
      fixture.substrate.getHealth(fixture.refs),
    ).resolves.toMatchObject({ healthy: true });

    const suspended = await suspendStack({ stackId: fixture.stackId }, deps);
    expect(suspended).toMatchObject({ status: "suspended", skipped: false });
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "suspended",
    });
    // The substrate really stopped: a suspended stack is not healthy.
    await expect(
      fixture.substrate.getHealth(fixture.refs),
    ).resolves.toMatchObject({ healthy: false, detail: "stack is suspended" });

    const resumed = await resumeStack({ stackId: fixture.stackId }, deps);
    expect(resumed).toMatchObject({ status: "running", skipped: false });
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "running",
    });
    await expect(
      fixture.substrate.getHealth(fixture.refs),
    ).resolves.toMatchObject({ healthy: true });

    expect(await auditActions(fixture.stackId)).toEqual(
      expect.arrayContaining(["stack.suspend", "stack.resume"]),
    );
  });

  it("is a no-op for a stack already in the target state", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };

    // Resume on a RUNNING stack: nothing to do, and nothing called.
    const alreadyRunning = await resumeStack(
      { stackId: fixture.stackId },
      deps,
    );
    expect(alreadyRunning).toMatchObject({ status: "running", skipped: true });
    expect(
      fixture.substrate.calls.filter((call) => call.method === "resume"),
    ).toHaveLength(0);

    await suspendStack({ stackId: fixture.stackId }, deps);
    const again = await suspendStack({ stackId: fixture.stackId }, deps);
    expect(again).toMatchObject({ status: "suspended", skipped: true });
    // Idempotent at the SUBSTRATE, not merely at the row: exactly one suspend.
    expect(
      fixture.substrate.calls.filter((call) => call.method === "suspend"),
    ).toHaveLength(1);
  });

  it("leaves the row untouched when the substrate refuses to suspend", async () => {
    const fixture = await seedRunningStack();
    fixture.substrate.failNext(
      "suspend",
      new SubstrateError("scripted suspend failure", { retryable: false }),
    );

    await expect(
      suspendStack(
        { stackId: fixture.stackId },
        { substrate: fixture.substrate },
      ),
    ).rejects.toThrow(/scripted suspend failure/);

    // Substrate BEFORE status: a failure must not leave a row claiming a pause
    // that never happened.
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "running",
    });
  });
});

describe("destroyStack", () => {
  it("REJECTS a destroy from running", async () => {
    const fixture = await seedRunningStack();

    await expect(
      destroyStack(
        { stackId: fixture.stackId },
        { substrate: fixture.substrate },
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    // Refused means nothing happened: no status change, no substrate call.
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "running",
    });
    expect(
      fixture.substrate.calls.filter((call) => call.method === "destroyStack"),
    ).toHaveLength(0);
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(true);
  });

  it("walks a suspended stack to destroyed, dropping the tenant database", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };

    await suspendStack({ stackId: fixture.stackId }, deps);
    // The database is real, and really there, before the destroy.
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(true);

    const result = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(result.status).toBe("destroyed");
    expect(result.steps.map((step) => step.step)).toEqual([...DESTROY_STEPS]);

    const row = await stackRow(fixture.stackId);
    expect(row.status).toBe("destroyed");
    // The credentials are gone, not merely unused.
    expect(row.dbDsnEncrypted).toBeNull();
    expect(row.hatchetTokenEncrypted).toBeNull();
    expect(row.stackSecretsEncrypted).toBeNull();

    // The outcome as the CLUSTER sees it — the only honest check.
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(false);
    expect(
      fixture.substrate.calls.filter((call) => call.method === "destroyStack"),
    ).toHaveLength(1);

    const actions = await auditActions(fixture.stackId);
    for (const step of DESTROY_STEPS) {
      expect(actions).toContain(destroyAuditAction(step));
    }
  });

  it("takes the SES tenant, its configuration set and the relay token with it", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };
    const ses = getFakeSesClient("us");
    const tenantName = sesTenantName(fixture.environmentId);
    const configurationSetName = sesConfigurationSetName(fixture.environmentId);

    // Provisioning really minted them, so the absences below mean something.
    expect(ses.__tenant(tenantName)).toBeDefined();
    expect(ses.__configurationSet(configurationSetName)).toBeDefined();
    expect(
      await getSesTenant({ environmentId: fixture.environmentId }),
    ).not.toBeNull();

    await suspendStack({ stackId: fixture.stackId }, deps);
    const result = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(result.status).toBe("destroyed");

    // A leaked configuration set keeps publishing events for an environment
    // that no longer exists, and a leaked tenant is billed monthly.
    expect(ses.__tenant(tenantName)).toBeUndefined();
    expect(ses.__configurationSet(configurationSetName)).toBeUndefined();
    expect(
      await getSesTenant({ environmentId: fixture.environmentId }),
    ).toBeNull();
    expect(
      await db
        .select()
        .from(relayTokens)
        .where(eq(relayTokens.environmentId, fixture.environmentId)),
    ).toHaveLength(0);
  });

  it("destroys a stack whose environment never had an SES tenant", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };
    // The state every stack provisioned before this step existed is in.
    await deprovisionSesTenant({ environmentId: fixture.environmentId });

    await suspendStack({ stackId: fixture.stackId }, deps);
    const result = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(result.status).toBe("destroyed");
    expect(
      result.steps.find((step) => step.step === "deprovision-ses")?.skipped,
    ).toBe(true);
  });

  it("parks in error and RESUMES the destroy without repeating finished steps", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };
    await suspendStack({ stackId: fixture.stackId }, deps);

    fixture.substrate.failNext(
      "destroyStack",
      new SubstrateError("scripted destroy failure", { retryable: false }),
    );

    const failed = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(failed.status).toBe("error");
    if (failed.status !== "error") throw new Error("unreachable");
    expect(failed.failedStep).toBe("substrate-destroy");

    const errored = await stackRow(fixture.stackId);
    expect(errored.status).toBe("error");
    expect(errored.lastError).toContain("substrate-destroy");
    // Nothing downstream ran: the database is still there.
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(true);

    // The retry, straight from `error` — the edge table's deliberate exception.
    const resumed = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(resumed.status).toBe("destroyed");
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "destroyed",
    });
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(false);

    // ONCE more, not twice: the failed call plus exactly one retry.
    expect(
      fixture.substrate.calls.filter((call) => call.method === "destroyStack"),
    ).toHaveLength(2);
  });

  it("skips finished steps on a re-run and tolerates a substrate that is already gone", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };
    await suspendStack({ stackId: fixture.stackId }, deps);
    await destroyStack({ stackId: fixture.stackId }, deps);

    // A destroyed stack is terminal: a second destroy answers without calling
    // anything (destroying → destroyed has no legal source from `destroyed`).
    const again = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(again.status).toBe("destroyed");
    expect(again.steps).toEqual([]);
    expect(
      fixture.substrate.calls.filter((call) => call.method === "destroyStack"),
    ).toHaveLength(1);
  });

  it("treats an already-deleted substrate stack as success", async () => {
    const fixture = await seedRunningStack();
    const deps = { substrate: fixture.substrate };
    await suspendStack({ stackId: fixture.stackId }, deps);

    // Someone deleted it out of band; destroy's goal is an ABSENCE, and this
    // is that absence.
    await fixture.substrate.destroyStack(fixture.refs);

    const result = await destroyStack({ stackId: fixture.stackId }, deps);
    expect(result.status).toBe("destroyed");
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(false);
  });
});

describe("environment operations (role gating)", () => {
  it("lets an owner suspend, resume and destroy with the name confirmed", async () => {
    const fixture = await seedRunningStack(authOrgId);
    const headers = await signIn(OWNER_EMAIL);
    const deps = { auth, lifecycle: { substrate: fixture.substrate } };

    await expect(
      suspendEnvironment(
        headers,
        { environmentId: fixture.environmentId },
        deps,
      ),
    ).resolves.toMatchObject({ status: "suspended" });
    await expect(
      resumeEnvironment(
        headers,
        { environmentId: fixture.environmentId },
        deps,
      ),
    ).resolves.toMatchObject({ status: "running" });

    await suspendEnvironment(
      headers,
      { environmentId: fixture.environmentId },
      deps,
    );
    await expect(
      destroyEnvironment(
        headers,
        {
          environmentId: fixture.environmentId,
          confirm: fixture.environmentName,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "destroyed" });
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(false);
  });

  it("refuses a plain member", async () => {
    const fixture = await seedRunningStack(authOrgId);
    const headers = await signIn(MEMBER_EMAIL);
    const deps = { auth, lifecycle: { substrate: fixture.substrate } };

    await expect(
      suspendEnvironment(
        headers,
        { environmentId: fixture.environmentId },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      resumeEnvironment(
        headers,
        { environmentId: fixture.environmentId },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      destroyEnvironment(
        headers,
        {
          environmentId: fixture.environmentId,
          confirm: fixture.environmentName,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);

    // Refused at the gate: the stack never moved and nothing was called.
    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "running",
    });
    expect(
      fixture.substrate.calls.filter((call) => call.method === "suspend"),
    ).toHaveLength(0);
  });

  it("refuses a destroy whose confirmation is not the environment name", async () => {
    const fixture = await seedRunningStack(authOrgId);
    const headers = await signIn(OWNER_EMAIL);
    const deps = { auth, lifecycle: { substrate: fixture.substrate } };
    await suspendEnvironment(
      headers,
      { environmentId: fixture.environmentId },
      deps,
    );

    await expect(
      destroyEnvironment(
        headers,
        { environmentId: fixture.environmentId, confirm: "not-the-name" },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConfirmationMismatchError);

    expect(await stackRow(fixture.stackId)).toMatchObject({
      status: "suspended",
    });
    expect(await databaseExistsOnCluster(fixture.dbName)).toBe(true);
  });
});
