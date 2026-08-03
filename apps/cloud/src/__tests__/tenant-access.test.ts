import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantCredentialClient } from "../services/tenant-credentials";

/**
 * The environment page's customer surface: the reveal actions' guards, what
 * they write to the audit trail, key create/revoke against a tenant instance,
 * and the provisioning-progress copy.
 *
 * Everything runs against the real control-plane database and real Better Auth
 * sessions — the guards under test ARE the query's organization scope and the
 * operator-role check, and a stubbed role would prove nothing about either.
 * Only the tenant instance is a fake, because there is no engine listening on
 * the seeded `apiPublicUrl`; the fake is injected through the same
 * `TenantCredentialClient` seam the provisioning pipeline uses.
 */

const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { cells, cloudAuditLog, environments, organizations, stacks } =
  await import("../db/schema");
const { member, organization, user } = await import("../db/schema/auth");
const { env } = await import("../env");
const { createCloudAuth } = await import("../lib/auth");
const { encryptSecretPayload } = await import("../lib/crypto");
const { NotPermittedError } = await import("../lib/org-members");
const { NotFoundError } = await import("../services/errors");
const {
  createFakeTenantCredentialClient,
  TENANT_INGEST_KEY_NAME,
  TenantCredentialError,
} = await import("../services/tenant-credentials");
const {
  ControlPlaneKeyError,
  createTenantKey,
  deriveProvisionProgress,
  ingestEnvSnippet,
  readTenantAccess,
  readTenantKeys,
  REVEAL_INGEST_KEY_ACTION,
  REVEAL_STUDIO_PASSWORD_ACTION,
  revealIngestSnippet,
  revealStudioPassword,
  revokeTenantKey,
  StudioPasswordRejectedError,
  studioUrlFor,
  TENANT_KEY_REVOKED_ACTION,
  TenantAccessUnavailableError,
} = await import("../lib/tenant-access");

const CELL_NAME = "aaa-tenant-access-test-us-1";
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";

const PASSWORD = "correct-horse-11";
const OWNER_A = "access-owner-a@hogsend.test";
const MEMBER_A = "access-member-a@hogsend.test";
const OWNER_B = "access-owner-b@hogsend.test";
const AUTH_ORG_PREFIX = "AccessTest";

/** The values the fixture stack's encrypted secret blob carries. */
const STUDIO_PASSWORD = "studio-pw-fixture-0123456789";
const INGEST_KEY = "hsk_fixture_control_plane";
const CONTROL_PLANE_KEY_ID = "key-control-plane";
const API_URL = "https://tenant-a.example.test";

const auth = createCloudAuth({ emailSender: { id: "spy", async send() {} } });

let orgA = "";
let orgB = "";
let envA = "";
let stackA = "";
let envB = "";

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

async function seedOrganization(
  ownerEmail: string,
  cellId: string | null,
): Promise<string> {
  const headers = await signIn(ownerEmail);
  const created = await auth.api.createOrganization({
    body: {
      name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
      slug: `access-${randomUUID()}`,
    },
    headers,
  });
  if (!created) throw new Error("fixture organization not created");
  await db.insert(organizations).values({
    id: created.id,
    name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
    region: "us",
    plan: "trial",
    cellId,
  });
  return created.id;
}

/**
 * A stack that looks exactly like one the pipeline finished: `running`, with
 * substrate refs, `credentialsMinted: true`, and a secret blob carrying both a
 * Studio password and the control-plane ingest key.
 */
async function seedProvisionedEnvironment(
  organizationId: string,
  name: string,
  apiPublicUrl: string,
): Promise<{ environmentId: string; stackId: string }> {
  const [environment] = await db
    .insert(environments)
    .values({ organizationId, name, kind: "production" })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  await db.insert(stacks).values({
    id: stackId,
    organizationId,
    environmentId: environment.id,
    status: "running",
    region: "us",
    hatchetNamespace: stackId,
    dbName: `t_access_${stackId.slice(0, 8)}`,
    substrateRefs: {
      substrate: "fake",
      apiPublicUrl,
      data: {},
      credentialsMinted: true,
    },
    stackSecretsEncrypted: encryptSecretPayload({
      betterAuthSecret: "b".repeat(48),
      studioAdminPassword: STUDIO_PASSWORD,
      ingestApiKey: INGEST_KEY,
      ingestApiKeyId: CONTROL_PLANE_KEY_ID,
    }),
  });
  return { environmentId: environment.id, stackId };
}

/**
 * A tenant instance under test control.
 *
 * Records every call so a test can assert the mutation REACHED the instance —
 * the point of the create/revoke tests is that the action is a real call, not
 * that it returned without throwing.
 */
function makeClient(): TenantCredentialClient & {
  keys: { id: string; name: string; revokedAt: string | null }[];
  revoked: string[];
  created: string[];
  signIns: number;
  fail?: Error;
} {
  const state = {
    keys: [
      {
        id: CONTROL_PLANE_KEY_ID,
        name: TENANT_INGEST_KEY_NAME,
        revokedAt: null as string | null,
      },
      { id: "key-customer", name: "my-app", revokedAt: null as string | null },
    ],
    revoked: [] as string[],
    created: [] as string[],
    signIns: 0,
    fail: undefined as Error | undefined,
    async signIn() {
      if (state.fail) throw state.fail;
      state.signIns += 1;
      return { cookie: "fake=1" };
    },
    async listKeys() {
      if (state.fail) throw state.fail;
      return state.keys.filter((key) => key.revokedAt === null);
    },
    async createKey({ name }: { name: string }) {
      if (state.fail) throw state.fail;
      state.created.push(name);
      const id = `key-new-${state.created.length}`;
      state.keys.push({ id, name, revokedAt: null });
      return { id, key: `hsk_new_${state.created.length}` };
    },
    async revokeKey({ keyId }: { keyId: string }) {
      if (state.fail) throw state.fail;
      state.revoked.push(keyId);
      const key = state.keys.find((entry) => entry.id === keyId);
      if (key) key.revokedAt = "revoked";
    },
  };
  return state as unknown as ReturnType<typeof makeClient>;
}

async function auditRowsFor(
  stackId: string,
  action: string,
): Promise<{ actor: string; detail: Record<string, unknown> | null }[]> {
  return db
    .select({ actor: cloudAuditLog.actor, detail: cloudAuditLog.detail })
    .from(cloudAuditLog)
    .where(
      and(eq(cloudAuditLog.subject, stackId), eq(cloudAuditLog.action, action)),
    );
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
  await db
    .delete(user)
    .where(inArray(user.email, [OWNER_A, MEMBER_A, OWNER_B]));
  await db.delete(cells).where(eq(cells.name, CELL_NAME));
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
      sharedHatchetUrl: "http://hatchet.access.test:8888",
      accepting: true,
      maxTenants: 100,
    })
    .returning();
  const cellId = cell?.id ?? null;

  for (const email of [OWNER_A, MEMBER_A, OWNER_B]) {
    await auth.api.signUpEmail({
      body: { name: email, email, password: PASSWORD },
    });
  }

  orgA = await seedOrganization(OWNER_A, cellId);
  orgB = await seedOrganization(OWNER_B, cellId);

  const [memberUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, MEMBER_A));
  if (!memberUser) throw new Error("fixture member user missing");
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgA,
    userId: memberUser.id,
    role: "member",
  });

  const a = await seedProvisionedEnvironment(orgA, "production", API_URL);
  envA = a.environmentId;
  stackA = a.stackId;
  envB = (
    await seedProvisionedEnvironment(
      orgB,
      "production",
      "https://tenant-b.example.test",
    )
  ).environmentId;
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end({ timeout: 5 });
});

describe("studioUrlFor / ingestEnvSnippet", () => {
  it("points at the engine's mounted Studio, with no double slash", () => {
    expect(studioUrlFor("https://x.test")).toBe("https://x.test/studio");
    expect(studioUrlFor("https://x.test/")).toBe("https://x.test/studio");
  });

  /**
   * The variable names are what make the snippet paste-and-work: they are the
   * ones `@hogsend/client` and the scaffold template read. A wrong name here
   * hands the customer a file that silently does nothing.
   */
  it("emits both variables the SDK reads", () => {
    expect(
      ingestEnvSnippet({ apiUrl: "https://x.test", apiKey: "hsk_1" }),
    ).toBe("HOGSEND_API_URL=https://x.test\nHOGSEND_API_KEY=hsk_1");
  });
});

describe("revealStudioPassword", () => {
  it("refuses a caller from another organization with a 404-shaped error", async () => {
    const headers = await signIn(OWNER_B);
    await expect(
      revealStudioPassword(headers, { environmentId: envA }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a member, who may read the environment but not administer it", async () => {
    const headers = await signIn(MEMBER_A);
    // The same caller CAN see the environment — proving the refusal is about
    // the role and not about visibility.
    const view = await readTenantAccess(headers, { environmentId: envA });
    expect(view?.ready).toBe(true);
    expect(view?.canReveal).toBe(false);

    await expect(
      revealStudioPassword(headers, { environmentId: envA }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  it("hands the owner the password and admin email, repeatably", async () => {
    const headers = await signIn(OWNER_A);
    const first = await revealStudioPassword(headers, { environmentId: envA });
    expect(first.password).toBe(STUDIO_PASSWORD);
    expect(first.email).toBe(OWNER_A);
    expect(first.studioUrl).toBe(`${API_URL}/studio`);

    // A second reveal must still work: a one-time lock would leave a customer
    // who lost the password unable to reach their own Studio.
    const second = await revealStudioPassword(headers, { environmentId: envA });
    expect(second.password).toBe(STUDIO_PASSWORD);
  });

  it("audits the reveal without recording the secret", async () => {
    const headers = await signIn(OWNER_A);
    const before = await auditRowsFor(stackA, REVEAL_STUDIO_PASSWORD_ACTION);
    await revealStudioPassword(headers, { environmentId: envA });
    const after = await auditRowsFor(stackA, REVEAL_STUDIO_PASSWORD_ACTION);

    expect(after.length).toBe(before.length + 1);
    const row = after.at(-1);
    expect(row?.actor).toBeTruthy();
    expect(row?.actor).not.toBe("system");
    // The whole row, serialised: no field of it may carry the password.
    expect(JSON.stringify(row)).not.toContain(STUDIO_PASSWORD);
  });
});

describe("revealIngestSnippet", () => {
  it("fills the snippet with the stored key and audits without it", async () => {
    const headers = await signIn(OWNER_A);
    const revealed = await revealIngestSnippet(headers, {
      environmentId: envA,
    });
    expect(revealed.snippet).toContain(`HOGSEND_API_URL=${API_URL}`);
    expect(revealed.snippet).toContain(`HOGSEND_API_KEY=${INGEST_KEY}`);

    const rows = await auditRowsFor(stackA, REVEAL_INGEST_KEY_ACTION);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(INGEST_KEY);
  });

  it("refuses a caller from another organization", async () => {
    const headers = await signIn(OWNER_B);
    await expect(
      revealIngestSnippet(headers, { environmentId: envA }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("tenant key management", () => {
  it("lists the instance's keys and flags the control-plane one", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    const listed = await readTenantKeys(
      headers,
      { environmentId: envA },
      { credentials: client },
    );
    expect(listed.error).toBeNull();
    expect(listed.keys.map((key) => key.name)).toEqual([
      TENANT_INGEST_KEY_NAME,
      "my-app",
    ]);
    expect(listed.keys[0]?.controlPlane).toBe(true);
    expect(listed.keys[1]?.controlPlane).toBe(false);
  });

  it("turns an instance that did not answer into a sentence, not a throw", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    client.fail = new TenantCredentialError(
      "Studio sign-in failed with HTTP 502",
    );

    const listed = await readTenantKeys(
      headers,
      { environmentId: envA },
      { credentials: client },
    );
    expect(listed.keys).toEqual([]);
    expect(listed.error).toContain("did not answer");
  });

  it("creates a key on the instance and returns material only once", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    const created = await createTenantKey(
      headers,
      { environmentId: envA, name: "my-second-app" },
      { credentials: client },
    );
    expect(client.created).toEqual(["my-second-app"]);
    expect(created.key).toMatch(/^hsk_new_/);
  });

  it("refuses to create a second key under the control plane's name", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    await expect(
      createTenantKey(
        headers,
        { environmentId: envA, name: TENANT_INGEST_KEY_NAME },
        { credentials: client },
      ),
    ).rejects.toBeInstanceOf(ControlPlaneKeyError);
    expect(client.created).toEqual([]);
  });

  it("revokes a customer key on the instance and audits it", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    await revokeTenantKey(
      headers,
      { environmentId: envA, keyId: "key-customer" },
      { credentials: client },
    );
    expect(client.revoked).toEqual(["key-customer"]);

    const rows = await auditRowsFor(stackA, TENANT_KEY_REVOKED_ACTION);
    expect(rows.at(-1)?.detail?.apiKeyId).toBe("key-customer");
  });

  it("refuses to revoke the control-plane key, and does not call the instance", async () => {
    const headers = await signIn(OWNER_A);
    const client = makeClient();
    await expect(
      revokeTenantKey(
        headers,
        { environmentId: envA, keyId: CONTROL_PLANE_KEY_ID },
        { credentials: client },
      ),
    ).rejects.toBeInstanceOf(ControlPlaneKeyError);
    expect(client.revoked).toEqual([]);
  });

  /**
   * The failure the page's own advice used to cause: a customer who changed
   * the Studio password leaves the control plane holding a dead credential.
   *
   * A 401 is a fact about OUR stored copy, not about the instance's health, so
   * it must not be rendered as "your instance did not answer" — that sends
   * both the customer and an operator hunting an outage that is not happening.
   */
  it("diagnoses a changed Studio password instead of blaming the instance", async () => {
    const headers = await signIn(OWNER_A);
    const client = createFakeTenantCredentialClient();
    client.failNext(
      "signIn",
      new TenantCredentialError("Studio sign-in failed with HTTP 401", 401),
    );

    const listed = await readTenantKeys(
      headers,
      { environmentId: envA },
      { credentials: client },
    );
    expect(listed.error).toContain("Studio password was changed");
    expect(listed.error).not.toContain("did not answer");

    // And on a mutation it is a typed refusal, not a swallowed string.
    client.failNext(
      "signIn",
      new TenantCredentialError("Studio sign-in failed with HTTP 401", 401),
    );
    await expect(
      createTenantKey(
        headers,
        { environmentId: envA, name: "after-rotation" },
        { credentials: client },
      ),
    ).rejects.toBeInstanceOf(StudioPasswordRejectedError);
  });

  /** A transport failure keeps the transport message: the two must not merge. */
  it("still reports a non-auth sign-in failure as an unreachable instance", async () => {
    const headers = await signIn(OWNER_A);
    const client = createFakeTenantCredentialClient();
    client.failNext(
      "signIn",
      new TenantCredentialError("Studio sign-in failed with HTTP 502", 502),
    );

    const listed = await readTenantKeys(
      headers,
      { environmentId: envA },
      { credentials: client },
    );
    expect(listed.error).toContain("did not answer");
    expect(listed.error).not.toContain("Studio password was changed");
  });

  it("refuses a member", async () => {
    const headers = await signIn(MEMBER_A);
    await expect(
      revokeTenantKey(
        headers,
        { environmentId: envA, keyId: "key-customer" },
        { credentials: makeClient() },
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  it("refuses a caller from another organization", async () => {
    const headers = await signIn(OWNER_B);
    await expect(
      createTenantKey(
        headers,
        { environmentId: envA, name: "sneaky" },
        { credentials: makeClient() },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("readTenantAccess", () => {
  it("returns null for another organization's environment", async () => {
    const headers = await signIn(OWNER_A);
    expect(await readTenantAccess(headers, { environmentId: envB })).toBeNull();
  });

  it("carries no secret", async () => {
    const headers = await signIn(OWNER_A);
    const view = await readTenantAccess(headers, { environmentId: envA });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(STUDIO_PASSWORD);
    expect(serialised).not.toContain(INGEST_KEY);
    expect(view?.studioUrl).toBe(`${API_URL}/studio`);
    expect(view?.adminEmail).toBe(OWNER_A);
  });

  it("refuses a reveal while a stack is still provisioning", async () => {
    const headers = await signIn(OWNER_A);
    // The same stack, temporarily un-minted: `credentialsMinted` is the flag
    // that says the credentials exist at all.
    await db
      .update(stacks)
      .set({
        substrateRefs: {
          substrate: "fake",
          apiPublicUrl: API_URL,
          data: {},
          credentialsMinted: false,
        },
      })
      .where(eq(stacks.id, stackA));
    try {
      expect(
        (await readTenantAccess(headers, { environmentId: envA }))?.ready,
      ).toBe(false);
      await expect(
        revealStudioPassword(headers, { environmentId: envA }),
      ).rejects.toBeInstanceOf(TenantAccessUnavailableError);
    } finally {
      await db
        .update(stacks)
        .set({
          substrateRefs: {
            substrate: "fake",
            apiPublicUrl: API_URL,
            data: {},
            credentialsMinted: true,
          },
        })
        .where(eq(stacks.id, stackA));
    }
  });
});

describe("deriveProvisionProgress", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const steps = [
    { step: "start" as const, state: "done" as const, at: now },
    { step: "set-env" as const, state: "pending" as const, at: null },
  ];

  it("says nothing has started when there is no stack", () => {
    const progress = deriveProvisionProgress({ stack: null, steps, now });
    expect(progress.state).toBe("not_started");
  });

  it("says it is working while a fresh run is in flight", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "provisioning",
        lastError: null,
        retryCount: 0,
        updatedAt: new Date(now.getTime() - 60_000),
      },
      steps,
      now,
    });
    expect(progress.state).toBe("working");
    expect(progress.step).toBe("set-env");
  });

  it("promises a retry for a provision failure under the ceiling", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "error",
        lastError: "[set-env] Problem processing request",
        retryCount: 2,
        updatedAt: now,
      },
      steps: [{ step: "set-env" as const, state: "failed" as const, at: now }],
      now,
    });
    expect(progress.state).toBe("retrying");
    expect(progress.message).toContain("retrying it automatically");
    // Named from `last_error`, which the parking write puts on the stack row
    // itself — so the copy is right even before the audit row lands.
    expect(progress.step).toBe("set-env");
  });

  it("names the failed step from last_error, not the first pending one", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "error",
        lastError: "[mint-credentials] Studio sign-in failed with HTTP 502",
        retryCount: 1,
        updatedAt: now,
      },
      // No failed entry at all: the audit trail has not caught up.
      steps,
      now,
    });
    expect(progress.step).toBe("mint-credentials");
  });

  it("promises a human once the attempt ceiling is exhausted", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "error",
        lastError: "[set-env] Problem processing request",
        retryCount: 5,
        updatedAt: now,
      },
      steps: [{ step: "set-env" as const, state: "failed" as const, at: now }],
      now,
    });
    expect(progress.state).toBe("alerted");
    expect(progress.message).toContain("alerted");
  });

  /**
   * A stack parked by a failed BUILD is not a provision candidate — the sweep
   * skips it — so the page must not promise a retry that will never come.
   */
  it("does not promise a retry for a failure outside provisioning", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "error",
        lastError: "[build 3] image build failed",
        retryCount: 1,
        updatedAt: now,
      },
      steps,
      now,
    });
    expect(progress.state).toBe("stalled");
    expect(progress.message).not.toContain("retrying it automatically");
  });

  it("picks up a provisioning row that has gone quiet past the stale window", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "provisioning",
        lastError: null,
        retryCount: 0,
        updatedAt: new Date(now.getTime() - 30 * 60 * 1000),
      },
      steps,
      now,
    });
    expect(progress.state).toBe("retrying");
  });

  it("says a deliberately stopped stack is not being provisioned", () => {
    const progress = deriveProvisionProgress({
      stack: {
        status: "suspended",
        lastError: null,
        retryCount: 0,
        updatedAt: now,
      },
      steps,
      now,
    });
    expect(progress.state).toBe("halted");
  });
});
