import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The build surfaces of the dashboard: the reads the environment page and the
 * build detail page run, and the one mutation they offer.
 *
 * Same posture as `environment-dashboard.test.ts`, for the same reason: a
 * server component cannot be called from a test with a session, so the tenancy
 * guard and the role gate live in `src/lib/build-views.ts` and are proved HERE,
 * against the real control-plane database and real Better Auth sessions. A
 * stubbed role would prove nothing about the query's scope.
 *
 * `next/headers` and `next/cache` are mocked so the REAL server action can be
 * called — a rotate is a POST endpoint anyone with a session can reach, and the
 * one-time secret it returns is the thing worth asserting end to end.
 */

let actionHeaders = new Headers();

vi.mock("next/headers", () => ({
  headers: async () => actionHeaders,
}));
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const { rotatePublishTokenAction } = await import(
  "../../app/environments/actions"
);

const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, environments, organizations, publishTokens } = await import(
  "../db/schema"
);
const { member, organization, user } = await import("../db/schema/auth");
const { env } = await import("../env");
const { createCloudAuth } = await import("../lib/auth");
const {
  BUILD_HISTORY_LENGTH,
  readBuildDetail,
  readBuildsView,
  rotatePublishToken,
} = await import("../lib/build-views");
const { NotPermittedError } = await import("../lib/org-members");
const { NotFoundError } = await import("../services/errors");
const { PublishTokenService } = await import("../services/publish-tokens");

const PASSWORD = "correct-horse-11";
const OWNER_A = "build-view-owner-a@hogsend.test";
const MEMBER_A = "build-view-member-a@hogsend.test";
const OWNER_B = "build-view-owner-b@hogsend.test";
const AUTH_ORG_PREFIX = "BuildViewTest";

const auth = createCloudAuth({
  emailSender: { id: "spy", async send() {} },
});
const tokens = new PublishTokenService(db);

let orgA = "";
let orgB = "";
let envA = "";
let envB = "";
/** An environment of org A that deliberately never had a token minted. */
let envTokenless = "";
let ownerHeaders = new Headers();
let memberHeaders = new Headers();
let outsiderHeaders = new Headers();

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

async function seedOrganization(ownerEmail: string): Promise<string> {
  const headers = await signIn(ownerEmail);
  const created = await auth.api.createOrganization({
    body: {
      name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
      slug: `build-view-${randomUUID()}`,
    },
    headers,
  });
  if (!created) throw new Error("fixture organization not created");

  await db.insert(organizations).values({
    id: created.id,
    name: `${AUTH_ORG_PREFIX} ${ownerEmail}`,
    region: "us",
    plan: "self_serve",
  });
  return created.id;
}

/**
 * An environment inserted directly rather than through
 * `insertEnvironmentWithStack`: that path mints a publish token, and one of
 * these fixtures exists precisely to have none.
 */
async function seedEnvironment(
  organizationId: string,
  name: string,
): Promise<string> {
  const [row] = await db
    .insert(environments)
    .values({ organizationId, name, kind: "test" })
    .returning();
  if (!row) throw new Error("fixture environment not created");
  return row.id;
}

async function seedBuild(
  environmentId: string,
  overrides: Partial<typeof builds.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await db.insert(builds).values({
    id,
    environmentId,
    status: "succeeded",
    artifactPath: `${environmentId}/${id}.tar.gz`,
    ...overrides,
  });
  return id;
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
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of [OWNER_A, MEMBER_A, OWNER_B]) {
    await auth.api.signUpEmail({
      body: { name: email, email, password: PASSWORD },
    });
  }

  orgA = await seedOrganization(OWNER_A);
  orgB = await seedOrganization(OWNER_B);

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

  envA = await seedEnvironment(orgA, "build-view-a");
  envB = await seedEnvironment(orgB, "build-view-b");
  envTokenless = await seedEnvironment(orgA, "build-view-tokenless");

  await tokens.mint({ environmentId: envA });
  await tokens.mint({ environmentId: envB });

  ownerHeaders = await signIn(OWNER_A);
  memberHeaders = await signIn(MEMBER_A);
  outsiderHeaders = await signIn(OWNER_B);
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end({ timeout: 5 });
});

describe("readBuildsView", () => {
  it("lists the environment's builds newest first with the token card", async () => {
    const older = await seedBuild(envA, {
      status: "failed",
      engineVersion: "0.55.0",
      error: "preflight refused the worker mode",
      createdAt: new Date("2026-07-01T10:00:00Z"),
    });
    const newer = await seedBuild(envA, {
      status: "succeeded",
      engineVersion: "0.56.0",
      imageDigest: "sha256:abc123def456",
      createdAt: new Date("2026-07-02T10:00:00Z"),
    });

    const view = await readBuildsView(ownerHeaders, { environmentId: envA });

    expect(view?.builds.map((build) => build.id)).toEqual([newer, older]);
    expect(view?.builds[0]).toMatchObject({
      status: "succeeded",
      engineVersion: "0.56.0",
      imageDigest: "sha256:abc123def456",
    });
    expect(view?.token.environmentId).toBe(envA);
    expect(view?.token.last4).toHaveLength(4);
    expect(view?.canRotate).toBe(true);
  });

  it("shows at most one page of history", async () => {
    const environmentId = await seedEnvironment(orgA, "build-view-history");
    for (let index = 0; index < BUILD_HISTORY_LENGTH + 3; index += 1) {
      await seedBuild(environmentId, {
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const view = await readBuildsView(ownerHeaders, { environmentId });
    expect(view?.builds).toHaveLength(BUILD_HISTORY_LENGTH);
  });

  it("mints the token row for an environment that predates publish tokens", async () => {
    const before = await tokens.get({ environmentId: envTokenless });
    expect(before).toBeNull();

    const view = await readBuildsView(ownerHeaders, {
      environmentId: envTokenless,
    });

    expect(view?.token.environmentId).toBe(envTokenless);
    // The card carries metadata and NOTHING that could be presented as a
    // credential — the backfilled secret is discarded, never rendered.
    expect(Object.keys(view?.token ?? {}).sort()).toEqual([
      "createdAt",
      "environmentId",
      "id",
      "last4",
      "rotatedAt",
    ]);
  });

  it("lets a member read, but not rotate", async () => {
    const view = await readBuildsView(memberHeaders, { environmentId: envA });
    expect(view).not.toBeNull();
    expect(view?.canRotate).toBe(false);
  });

  it("reads another tenant's environment as absent", async () => {
    expect(
      await readBuildsView(outsiderHeaders, { environmentId: envA }),
    ).toBeNull();
    expect(
      await readBuildsView(ownerHeaders, { environmentId: envB }),
    ).toBeNull();
    expect(
      await readBuildsView(ownerHeaders, { environmentId: randomUUID() }),
    ).toBeNull();
  });
});

describe("readBuildDetail", () => {
  it("returns the build with its log tail", async () => {
    const buildId = await seedBuild(envA, {
      status: "failed",
      logTail: "#5 [build 3/7] RUN pnpm build\nerror: exit 1\n",
      error: "docker build failed",
    });

    const build = await readBuildDetail(ownerHeaders, {
      environmentId: envA,
      buildId,
    });

    expect(build?.logTail).toContain("exit 1");
    expect(build?.error).toBe("docker build failed");
  });

  it("reads a build of another environment as absent, even one's own", async () => {
    const foreign = await seedBuild(envB);
    const mine = await seedBuild(envA);

    expect(
      await readBuildDetail(outsiderHeaders, {
        environmentId: envA,
        buildId: mine,
      }),
    ).toBeNull();
    // The build exists, but not under the environment it was asked for.
    expect(
      await readBuildDetail(ownerHeaders, {
        environmentId: envA,
        buildId: foreign,
      }),
    ).toBeNull();
    expect(
      await readBuildDetail(ownerHeaders, {
        environmentId: envA,
        buildId: randomUUID(),
      }),
    ).toBeNull();
  });
});

describe("rotatePublishToken", () => {
  it("issues a token that works and retires the one that did", async () => {
    const environmentId = await seedEnvironment(orgA, "build-view-rotate");
    const first = await tokens.mint({ environmentId });

    const rotated = await rotatePublishToken(ownerHeaders, { environmentId });

    expect(rotated.token).toMatch(/^hspub_/);
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.replaced).toBe(true);
    expect(rotated.summary.rotatedAt).not.toBeNull();
    await expect(tokens.verify({ token: rotated.token })).resolves.toEqual({
      found: true,
      environmentId,
      tokenId: rotated.summary.id,
    });
    await expect(tokens.verify({ token: first.token })).resolves.toEqual({
      found: false,
    });
  });

  it("rotates an environment that never had a token, in one call", async () => {
    const environmentId = await seedEnvironment(orgA, "build-view-backfill");

    const rotated = await rotatePublishToken(ownerHeaders, { environmentId });

    await expect(
      tokens.verify({ token: rotated.token }),
    ).resolves.toMatchObject({ found: true, environmentId });
  });

  it("refuses a member", async () => {
    await expect(
      rotatePublishToken(memberHeaders, { environmentId: envA }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  it("refuses another tenant's environment as not found", async () => {
    await expect(
      rotatePublishToken(outsiderHeaders, { environmentId: envA }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("rotatePublishTokenAction", () => {
  it("hands the caller the new token exactly once", async () => {
    const environmentId = await seedEnvironment(orgA, "build-view-action");
    await tokens.mint({ environmentId });
    actionHeaders = ownerHeaders;

    const form = new FormData();
    form.set("environmentId", environmentId);
    const state = await rotatePublishTokenAction(
      { error: null, token: null },
      form,
    );

    expect(state.error).toBeNull();
    expect(state.token).toMatch(/^hspub_/);
    await expect(
      tokens.verify({ token: state.token ?? "" }),
    ).resolves.toMatchObject({ found: true, environmentId });

    // The state is the ONLY copy: nothing readable afterwards carries it.
    const [row] = await db
      .select()
      .from(publishTokens)
      .where(eq(publishTokens.environmentId, environmentId));
    expect(JSON.stringify(row)).not.toContain(state.token);
  });

  it("prints a member's refusal instead of issuing anything", async () => {
    actionHeaders = memberHeaders;

    const form = new FormData();
    form.set("environmentId", envA);
    const state = await rotatePublishTokenAction(
      { error: null, token: null },
      form,
    );

    expect(state.token ?? null).toBeNull();
    expect(state.error).toContain("owner or admin");
  });

  it("refuses a form that names no environment", async () => {
    actionHeaders = ownerHeaders;

    const state = await rotatePublishTokenAction(
      { error: null, token: null },
      new FormData(),
    );

    expect(state.token ?? null).toBeNull();
    expect(state.error).toBeTruthy();
  });
});
