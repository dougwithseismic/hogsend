import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EnvironmentOperation } from "../lib/environment-ops";
import type { CreateEnvironmentResult } from "../services/environments";
import type { StackStatus } from "../services/stacks";

/**
 * The dashboard's environment surfaces: the tenancy guard the detail page's
 * 404 is made of, the button-visibility matrix, the provisioning-progress
 * derivation, and the create form's refusals.
 *
 * `next/headers` and `next/cache` are mocked so the REAL server action can be
 * called: a form action is the thing a browser posts to, and asserting that a
 * plan limit reaches it as a printable sentence is only worth doing against the
 * action itself. Everything else runs against the real control-plane database
 * and real Better Auth sessions — the guard under test IS the query's scope,
 * and a stubbed role would prove nothing about it.
 */

/** The header set `headers()` answers with inside the mocked action calls. */
let actionHeaders = new Headers();

vi.mock("next/headers", () => ({
  headers: async () => actionHeaders,
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { createEnvironmentAction } = await import(
  "../../app/environments/actions"
);

const { db } = await import("../db");
const { sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const {
  cells,
  cloudAuditLog,
  environments,
  organizations,
  stackHealth,
  stacks,
} = await import("../db/schema");
const { member, organization, user } = await import("../db/schema/auth");
const { env } = await import("../env");
const { createCloudAuth } = await import("../lib/auth");
const { encryptSecretPayload } = await import("../lib/crypto");
const { deriveProvisionSteps, readEnvironmentDetail } = await import(
  "../lib/environment-detail"
);
const { allowedOperations, createEnvironment, retryEnvironmentProvisioning } =
  await import("../lib/environment-ops");
const { NotPermittedError } = await import("../lib/org-members");
const { provisionAuditAction } = await import("../pipeline/provision");
const { IllegalTransitionError } = await import("../services/errors");

const CELL_NAME = "aaa-dashboard-test-us-1";
const CLUSTER_DSN =
  process.env.CLOUD_TEST_CLUSTER_DSN ??
  "postgres://growthhog:growthhog@localhost:5434/postgres";

const PASSWORD = "correct-horse-11";
const OWNER_A = "dashboard-owner-a@hogsend.test";
const MEMBER_A = "dashboard-member-a@hogsend.test";
const OWNER_B = "dashboard-owner-b@hogsend.test";
const AUTH_ORG_PREFIX = "DashboardTest";

const auth = createCloudAuth({
  emailSender: { id: "spy", async send() {} },
});

let orgA = "";
let orgB = "";
let envA = "";
let stackA = "";
let envB = "";

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

async function seedOrganization(
  ownerEmail: string,
  cellId: string | null,
): Promise<string> {
  const headers = await signIn(ownerEmail);
  const created = await auth.api.createOrganization({
    body: {
      name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
      slug: `dashboard-${randomUUID()}`,
    },
    headers,
  });
  if (!created) throw new Error("fixture organization not created");

  await db.insert(organizations).values({
    id: created.id,
    name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
    region: "us",
    // Trial (one environment) so the plan limit is reachable with the single
    // production environment every organization already has.
    plan: "trial",
    cellId,
  });
  return created.id;
}

/** An environment + its stack row, inserted directly: this suite is about the
 * READS, and running the pipeline would create real tenant databases. */
async function seedEnvironment(
  organizationId: string,
  name: string,
  status: "requested" | "running" | "error" | "suspended" = "error",
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
    status,
    region: "us",
    hatchetNamespace: stackId,
    dbName: `t_dash_${stackId.slice(0, 8)}`,
    ...(status === "error"
      ? { lastError: "[set-env] scripted failure", retryCount: 2 }
      : {}),
  });
  return { environmentId: environment.id, stackId };
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
      sharedHatchetUrl: "http://hatchet.dashboard.test:8888",
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

  const a = await seedEnvironment(orgA, "production");
  envA = a.environmentId;
  stackA = a.stackId;
  envB = (await seedEnvironment(orgB, "production")).environmentId;
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end({ timeout: 5 });
});

describe("allowedOperations", () => {
  /**
   * The WHOLE matrix, written out rather than derived: this is the table the
   * dashboard renders buttons from, and a test that re-derived it from the
   * same source would agree with any change including a wrong one.
   */
  const MATRIX: Record<StackStatus, EnvironmentOperation[]> = {
    requested: ["retry"],
    provisioning: [],
    running: ["suspend"],
    publishing: [],
    suspended: ["resume", "destroy"],
    destroying: [],
    destroyed: [],
    error: ["retry", "destroy"],
  };
  const STATUSES = Object.keys(MATRIX) as StackStatus[];

  it("offers an owner exactly the operations the status admits", () => {
    for (const status of STATUSES) {
      expect({
        status,
        ops: allowedOperations({ role: "owner", status }),
      }).toEqual({ status, ops: MATRIX[status] });
    }
  });

  it("offers an admin the same set as an owner", () => {
    for (const status of STATUSES) {
      expect(allowedOperations({ role: "admin", status })).toEqual(
        allowedOperations({ role: "owner", status }),
      );
    }
  });

  it("offers a member, an unknown role and no role nothing at all", () => {
    for (const role of ["member", "billing", "", null, undefined]) {
      for (const status of STATUSES) {
        expect(allowedOperations({ role, status })).toEqual([]);
      }
    }
  });

  it("offers nothing when the environment has no stack", () => {
    expect(allowedOperations({ role: "owner", status: null })).toEqual([]);
  });

  it("reads a comma-separated role list", () => {
    expect(
      allowedOperations({ role: "member,admin", status: "running" }),
    ).toEqual(["suspend"]);
  });
});

describe("deriveProvisionSteps", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

  it("calls every step pending when nothing has run", () => {
    const steps = deriveProvisionSteps({ audit: [], status: "requested" });
    expect(steps.every((step) => step.state === "pending")).toBe(true);
    expect(steps[0]?.step).toBe("start");
  });

  it("separates work done from work skipped on an artifact", () => {
    const steps = deriveProvisionSteps({
      status: "provisioning",
      audit: [
        { action: provisionAuditAction("start"), detail: {}, createdAt: at(0) },
        {
          action: provisionAuditAction("ensure-tenant-db"),
          detail: { reused: true },
          createdAt: at(1),
        },
      ],
    });
    expect(steps.find((step) => step.step === "start")?.state).toBe("done");
    expect(
      steps.find((step) => step.step === "ensure-tenant-db"),
    ).toMatchObject({
      state: "skipped",
      at: at(1),
    });
    expect(steps.find((step) => step.step === "set-env")?.state).toBe(
      "pending",
    );
  });

  it("marks the failed step, but only while the stack is in error", () => {
    const audit = [
      { action: provisionAuditAction("start"), detail: {}, createdAt: at(0) },
      {
        action: "stack.error",
        detail: { step: "set-env" },
        createdAt: at(1),
      },
    ];
    expect(
      deriveProvisionSteps({ audit, status: "error" }).find(
        (step) => step.step === "set-env",
      )?.state,
    ).toBe("failed");
    // The same trail, after a retry got past it: nothing is red any more.
    expect(
      deriveProvisionSteps({ audit, status: "provisioning" }).find(
        (step) => step.step === "set-env",
      )?.state,
    ).toBe("pending");
  });

  it("lets a later run overwrite an earlier row for the same step", () => {
    const steps = deriveProvisionSteps({
      status: "running",
      audit: [
        {
          action: provisionAuditAction("ensure-tenant-db"),
          detail: {},
          createdAt: at(0),
        },
        {
          action: provisionAuditAction("ensure-tenant-db"),
          detail: { reused: true },
          createdAt: at(5),
        },
      ],
    });
    expect(
      steps.find((step) => step.step === "ensure-tenant-db"),
    ).toMatchObject({ state: "skipped", at: at(5) });
  });
});

describe("readEnvironmentDetail (tenancy guard)", () => {
  it("gives an owner their own environment, with its operations", async () => {
    const detail = await readEnvironmentDetail(
      await signIn(OWNER_A),
      { environmentId: envA },
      { auth },
    );
    expect(detail).not.toBeNull();
    expect(detail?.environment.id).toBe(envA);
    expect(detail?.stack?.status).toBe("error");
    expect(detail?.operations).toMatchObject({
      role: "owner",
      allowed: ["retry", "destroy"],
    });
    // trial is a shared-cell plan; the pipeline derives topology the same way.
    expect(detail?.topology).toBe("shared");
  });

  it("gives another organization's owner nothing — the page's 404", async () => {
    await expect(
      readEnvironmentDetail(
        await signIn(OWNER_B),
        { environmentId: envA },
        { auth },
      ),
    ).resolves.toBeNull();
    // And the reverse, so the guard is the SCOPE and not a lucky ordering.
    await expect(
      readEnvironmentDetail(
        await signIn(OWNER_A),
        { environmentId: envB },
        { auth },
      ),
    ).resolves.toBeNull();
  });

  it("is null for an environment that does not exist", async () => {
    await expect(
      readEnvironmentDetail(
        await signIn(OWNER_A),
        { environmentId: randomUUID() },
        { auth },
      ),
    ).resolves.toBeNull();
  });

  it("lets a member read the environment but offers no operations", async () => {
    const detail = await readEnvironmentDetail(
      await signIn(MEMBER_A),
      { environmentId: envA },
      { auth },
    );
    expect(detail?.environment.id).toBe(envA);
    expect(detail?.operations).toMatchObject({ role: "member", allowed: [] });
  });

  it("reads the step list off the audit trail and the health log", async () => {
    await db.insert(cloudAuditLog).values([
      {
        actor: "provisioner",
        organizationId: orgA,
        action: provisionAuditAction("start"),
        subject: stackA,
        detail: {},
      },
      {
        actor: "provisioner",
        organizationId: orgA,
        action: "stack.error",
        subject: stackA,
        detail: { step: "set-env" },
      },
    ]);
    await db.insert(stackHealth).values([
      {
        stackId: stackA,
        organizationId: orgA,
        healthy: false,
        detail: "connection refused",
        checkedAt: new Date(Date.UTC(2026, 0, 1, 0, 1)),
      },
      {
        stackId: stackA,
        organizationId: orgA,
        healthy: true,
        detail: null,
        checkedAt: new Date(Date.UTC(2026, 0, 1, 0, 2)),
      },
    ]);

    const detail = await readEnvironmentDetail(
      await signIn(OWNER_A),
      { environmentId: envA },
      { auth },
    );
    const byStep = new Map(
      detail?.steps.map((step) => [step.step, step.state]),
    );
    expect(byStep.get("start")).toBe("done");
    expect(byStep.get("set-env")).toBe("failed");
    expect(byStep.get("finish")).toBe("pending");
    // Newest first, as the strip reverses it.
    expect(detail?.health.map((row) => row.healthy)).toEqual([true, false]);
    // The stack is not running, so it cannot be alerting.
    expect(detail?.alert).toBeNull();
  });
});

describe("retryEnvironmentProvisioning", () => {
  it("enqueues the same stack for an owner of an errored environment", async () => {
    const enqueue = vi.fn(async (stackId: string) => ({
      stackId,
      mode: "inline" as const,
    }));
    await expect(
      retryEnvironmentProvisioning(
        await signIn(OWNER_A),
        { environmentId: envA },
        { auth, enqueueProvision: enqueue },
      ),
    ).resolves.toEqual({ stackId: stackA });
    expect(enqueue).toHaveBeenCalledWith(stackA);
  });

  it("refuses a member, without enqueueing anything", async () => {
    const enqueue = vi.fn();
    await expect(
      retryEnvironmentProvisioning(
        await signIn(MEMBER_A),
        { environmentId: envA },
        { auth, enqueueProvision: enqueue },
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses another organization's environment", async () => {
    await expect(
      retryEnvironmentProvisioning(
        await signIn(OWNER_B),
        { environmentId: envA },
        { auth, enqueueProvision: vi.fn() },
      ),
    ).rejects.toThrow(/was not found/);
  });

  it("refuses a status that cannot reach provisioning", async () => {
    const { environmentId } = await seedEnvironment(
      orgB,
      `running-${randomUUID().slice(0, 8)}`,
      "running",
    );
    await expect(
      retryEnvironmentProvisioning(
        await signIn(OWNER_B),
        { environmentId },
        { auth, enqueueProvision: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe("createEnvironment", () => {
  it("creates for the CALLER's organization, through the provisioning path", async () => {
    // The spy stands in for `provisionEnvironment`: this test is about WHICH
    // organization and arguments it is called with, not the rows it returns.
    const provision = vi.fn(
      async () =>
        ({
          environment: { id: "env", name: "staging" },
          stack: { id: "stack" },
        }) as unknown as CreateEnvironmentResult,
    );
    await createEnvironment(
      await signIn(OWNER_A),
      { name: "staging", kind: "staging" },
      { auth, provisionEnvironment: provision },
    );
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgA,
        name: "staging",
        kind: "staging",
      }),
      {},
    );
  });

  it("refuses a member", async () => {
    const provision = vi.fn(
      async () => ({}) as unknown as CreateEnvironmentResult,
    );
    await expect(
      createEnvironment(
        await signIn(MEMBER_A),
        { name: "staging", kind: "staging" },
        { auth, provisionEnvironment: provision },
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);
    expect(provision).not.toHaveBeenCalled();
  });
});

describe("createEnvironmentAction", () => {
  it("prints the plan limit the service refused on", async () => {
    actionHeaders = await signIn(OWNER_A);
    const state = await createEnvironmentAction(
      { error: null },
      formData({ name: "staging", kind: "staging" }),
    );
    // The trial plan allows one environment and the organization has its
    // production one, so the service refuses inside its own transaction.
    expect(state.error).toContain('Plan "trial" allows 1 environment');
    expect(state.notice).toBeUndefined();
    // Nothing was created by the refused call.
    const rows = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.organizationId, orgA));
    expect(rows).toHaveLength(1);
  });

  it("rejects a name the environment naming rule forbids", async () => {
    actionHeaders = await signIn(OWNER_A);
    const state = await createEnvironmentAction(
      { error: null },
      formData({ name: "Staging Prod", kind: "staging" }),
    );
    expect(state.error).toContain("lowercase");
  });

  it("refuses a member before any rule about the plan", async () => {
    actionHeaders = await signIn(MEMBER_A);
    const state = await createEnvironmentAction(
      { error: null },
      formData({ name: "staging", kind: "staging" }),
    );
    expect(state.error).toContain("owner or admin");
  });
});

function formData(values: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
}
