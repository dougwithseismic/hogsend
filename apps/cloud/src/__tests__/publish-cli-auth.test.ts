import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The publish intake and the build-status endpoint under BOTH credentials, over
 * the real routes, the real database and a real (temporary) artifacts tree.
 *
 * What a mock would let through, and what is therefore asserted here:
 *  - a CLI session carries no authority of its own. Revoke it, demote its
 *    human, remove them from the org — the very next request is refused,
 *    with no rotation and nothing to sweep;
 *  - an organization boundary is a boundary. A session from org B posting at
 *    org A's environment is 403, not an accepted upload;
 *  - a version disagreement with the stack refuses BEFORE anything is written,
 *    and `allowUpgrade` is the only way past it;
 *  - the two endpoints agree about who may see what: a build a caller could
 *    create but not read would be a CLI that hangs.
 *
 * The artifacts root is repointed at a temp directory BEFORE `src/env.ts` is
 * imported, so the suite never writes into the repository.
 */
const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-cli-publish-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { and, eq, inArray, like } = await import("drizzle-orm");
const { POST: publishRoute } = await import(
  "../../app/api/publish/[environmentId]/route"
);
const { GET: buildRoute } = await import(
  "../../app/api/builds/[buildId]/route"
);
const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, cells, cliSessions, cloudAuditLog, organizations, stacks } =
  await import("../db/schema");
const { member, organization, user } = await import("../db/schema/auth");
const { env } = await import("../env");
const { createCloudAuth } = await import("../lib/auth");
const { provisionOrganization } = await import("../lib/org-provision");
const { buildService } = await import("../services/builds");
const { CliSessionService } = await import("../services/cli-sessions");
const { PublishTokenService } = await import("../services/publish-tokens");
const { OrgService } = await import("../services/orgs");
type EmailSender = import("../lib/email-sender").EmailSender;

const PASSWORD = "correct-horse-8";
const OWNER = "publish-cli-owner@hogsend.test";
const PLAIN = "publish-cli-plain@hogsend.test";
const OUTSIDER = "publish-cli-outsider@hogsend.test";
const EMAILS = [OWNER, PLAIN, OUTSIDER];

const US_CELL = "publish-cli-us-1";
const ORG_PREFIX = "PublishCliTest";
const ENGINE_VERSION = "0.56.0";

const spySender: EmailSender = { id: "spy", async send() {} };
const auth = createCloudAuth({ emailSender: spySender });
const orgService = new OrgService(db);
const sessions = new CliSessionService(db);
const tokens = new PublishTokenService(db);

let orgA = "";
let orgB = "";
let ownerId = "";
let plainId = "";
let outsiderId = "";
let envA = "";
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

/** Two bytes of gzip magic in front of some payload. */
function gzipBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  return bytes;
}

function uploadRequest(
  environmentId: string,
  options: {
    token?: string;
    engineVersion?: string;
    allowUpgrade?: boolean;
  } = {},
): Request {
  const form = new FormData();
  form.set(
    "manifest",
    JSON.stringify({
      engineVersion: options.engineVersion ?? ENGINE_VERSION,
      appName: "acme-lifecycle",
      ...(options.allowUpgrade === undefined
        ? {}
        : { allowUpgrade: options.allowUpgrade }),
    }),
  );
  form.set(
    "tarball",
    new File([gzipBytes() as BlobPart], "app.tar.gz", {
      type: "application/gzip",
    }),
  );

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return new Request(`http://localhost:3004/api/publish/${environmentId}`, {
    method: "POST",
    headers,
    body: form,
  });
}

function publish(
  environmentId: string,
  options: Parameters<typeof uploadRequest>[1] = {},
): Promise<Response> {
  return publishRoute(uploadRequest(environmentId, options), {
    params: Promise.resolve({ environmentId }),
  });
}

function readBuild(buildId: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return buildRoute(
    new Request(`http://localhost:3004/api/builds/${buildId}`, { headers }),
    { params: Promise.resolve({ buildId }) },
  );
}

async function buildRows(environmentId: string) {
  return db
    .select()
    .from(builds)
    .where(eq(builds.environmentId, environmentId));
}

function storedArtifacts(environmentId: string): string[] {
  const dir = join(ARTIFACTS_ROOT, environmentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/**
 * Wipe an environment's builds AND its stored tarballs, so each case starts
 * from an empty queue and can assert "this refusal wrote nothing" without
 * being coupled to what an earlier case legitimately left behind.
 */
async function resetBuilds(environmentId: string): Promise<void> {
  await db.delete(builds).where(eq(builds.environmentId, environmentId));
  rmSync(join(ARTIFACTS_ROOT, environmentId), {
    recursive: true,
    force: true,
  });
}

async function setStackEngineVersion(
  environmentId: string,
  version: string | null,
): Promise<void> {
  await db
    .update(stacks)
    .set({ engineVersion: version })
    .where(eq(stacks.environmentId, environmentId));
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, EMAILS));
  await db.delete(cells).where(eq(cells.name, US_CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of EMAILS) {
    await auth.api.signUpEmail({
      body: { name: email.split("@")[0] as string, email, password: PASSWORD },
    });
  }
  const users = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(inArray(user.email, EMAILS));
  ownerId = users.find((row) => row.email === OWNER)?.id ?? "";
  plainId = users.find((row) => row.email === PLAIN)?.id ?? "";
  outsiderId = users.find((row) => row.email === OUTSIDER)?.id ?? "";

  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  const a = await provisionOrganization(
    { name: `${ORG_PREFIX} Alpha`, region: "us", headers: await signIn(OWNER) },
    { auth, orgService },
  );
  orgA = a.organizationId;
  envA = a.environmentId;

  const b = await provisionOrganization(
    {
      name: `${ORG_PREFIX} Beta`,
      region: "us",
      headers: await signIn(OUTSIDER),
    },
    { auth, orgService },
  );
  orgB = b.organizationId;
  envB = b.environmentId;

  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgA,
    userId: plainId,
    role: "member",
  });

  await setStackEngineVersion(envA, ENGINE_VERSION);
  await setStackEngineVersion(envB, ENGINE_VERSION);
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("publish intake — hscli_ sessions", () => {
  it("accepts an owner's CLI session and files the build under it", async () => {
    await resetBuilds(envA);
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "owner-laptop",
    });

    const response = await publish(envA, { token });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { buildId: string };

    const rows = await buildRows(envA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.buildId);

    // The audit row names the SESSION, so an incident can be traced to the
    // machine — and it names no part of the credential.
    const [audit] = await db
      .select()
      .from(cloudAuditLog)
      .where(eq(cloudAuditLog.subject, body.buildId));
    expect(audit?.actor).toBe(`cli_session:${summary.id}`);
    expect(JSON.stringify(audit)).not.toContain(token);

    // A publish is a use: last_used_at is now set.
    const [row] = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, summary.id));
    expect(row?.lastUsedAt).not.toBeNull();
    const stamp = row?.lastUsedAt?.toISOString();

    // ...and a second publish moments later does NOT rewrite it. Throttled, so
    // a status poll every few seconds is not a write per poll.
    await publish(envA, { token });
    const [again] = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, summary.id));
    expect(again?.lastUsedAt?.toISOString()).toBe(stamp);
  });

  it("refuses a REVOKED session, storing nothing", async () => {
    await resetBuilds(envA);
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "stolen-laptop",
    });
    await sessions.revoke({ sessionId: summary.id, organizationId: orgA });

    const response = await publish(envA, { token });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(await buildRows(envA)).toHaveLength(0);
  });

  it("refuses a session whose human is only a member", async () => {
    await resetBuilds(envA);
    const { token } = await sessions.create({
      userId: plainId,
      organizationId: orgA,
      label: "member-laptop",
    });

    const response = await publish(envA, { token });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role" });
    expect(await buildRows(envA)).toHaveLength(0);
    expect(storedArtifacts(envA)).toHaveLength(0);
  });

  it("accepts that same session once the member is promoted, and refuses again after removal", async () => {
    await resetBuilds(envA);
    const { token } = await sessions.create({
      userId: plainId,
      organizationId: orgA,
      label: "promoted-laptop",
    });

    // The role is re-read at every use: nothing about the session changed.
    await db
      .update(member)
      .set({ role: "developer" })
      .where(and(eq(member.organizationId, orgA), eq(member.userId, plainId)));
    expect((await publish(envA, { token })).status).toBe(202);

    await db
      .delete(member)
      .where(and(eq(member.organizationId, orgA), eq(member.userId, plainId)));
    const after = await publish(envA, { token });
    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ error: "forbidden_role" });

    // Put the membership back for the rest of the suite.
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgA,
      userId: plainId,
      role: "member",
    });
  });

  it("refuses a session from another organization with 403", async () => {
    await resetBuilds(envA);
    const { token } = await sessions.create({
      userId: outsiderId,
      organizationId: orgB,
      label: "beta-laptop",
    });

    const response = await publish(envA, { token });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden_organization",
    });
    expect(await buildRows(envA)).toHaveLength(0);
    expect(storedArtifacts(envA)).toHaveLength(0);
  });

  it("refuses a made-up CLI token as 401, not 403", async () => {
    await resetBuilds(envA);
    const response = await publish(envA, { token: "hscli_not-a-real-token" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
  });
});

describe("publish intake — engine version", () => {
  it("refuses a manifest that disagrees with the stack, storing nothing", async () => {
    await resetBuilds(envA);
    const { token } = await tokens.mint({ environmentId: envA });

    const response = await publish(envA, {
      token,
      engineVersion: "0.57.0",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "engine_version_mismatch",
      stackVersion: ENGINE_VERSION,
      manifestVersion: "0.57.0",
    });
    expect(await buildRows(envA)).toHaveLength(0);
    expect(storedArtifacts(envA)).toHaveLength(0);
  });

  it("accepts the same upload with allowUpgrade set", async () => {
    await resetBuilds(envA);
    const { token } = await tokens.mint({ environmentId: envA });

    const response = await publish(envA, {
      token,
      engineVersion: "0.57.0",
      allowUpgrade: true,
    });
    expect(response.status).toBe(202);
    const rows = await buildRows(envA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.engineVersion).toBe("0.57.0");
  });

  it("has nothing to disagree with on a stack that never deployed", async () => {
    await resetBuilds(envA);
    await setStackEngineVersion(envA, null);
    const { token } = await tokens.mint({ environmentId: envA });

    expect(
      (await publish(envA, { token, engineVersion: "0.99.0" })).status,
    ).toBe(202);
    await setStackEngineVersion(envA, ENGINE_VERSION);
  });

  it("still accepts a matching publish token — the existing path is unchanged", async () => {
    await resetBuilds(envA);
    const { token } = await tokens.mint({ environmentId: envA });
    const response = await publish(envA, { token });
    expect(response.status).toBe(202);
    const [row] = await buildRows(envA);
    expect(row?.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe("GET /api/builds/:buildId", () => {
  let buildId = "";
  let publishToken = "";
  let ownerToken = "";
  let outsiderToken = "";
  let memberToken = "";

  beforeAll(async () => {
    await resetBuilds(envA);
    publishToken = (await tokens.mint({ environmentId: envA })).token;
    ownerToken = (
      await sessions.create({
        userId: ownerId,
        organizationId: orgA,
        label: "status-owner",
      })
    ).token;
    outsiderToken = (
      await sessions.create({
        userId: outsiderId,
        organizationId: orgB,
        label: "status-outsider",
      })
    ).token;
    memberToken = (
      await sessions.create({
        userId: plainId,
        organizationId: orgA,
        label: "status-member",
      })
    ).token;

    // Created directly rather than through the intake: the fake substrate runs
    // the build pipeline in-process, and this suite is about what the STATUS
    // endpoint answers for a given row, not about a build racing it.
    const build = await buildService.create({
      environmentId: envA,
      artifactPath: `${envA}/status-fixture.tar.gz`,
      manifest: { engineVersion: ENGINE_VERSION },
      engineVersion: ENGINE_VERSION,
      actor: "test",
    });
    buildId = build.id;
  });

  it("refuses with no credential and with a bad one", async () => {
    expect((await readBuild(buildId)).status).toBe(401);
    expect((await readBuild(buildId, "hspub_nope")).status).toBe(401);
    expect((await readBuild(buildId, "hscli_nope")).status).toBe(401);
  });

  it("answers the environment's own publish token, and never caches", async () => {
    const response = await readBuild(buildId, publishToken);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: buildId,
      environmentId: envA,
      status: "queued",
      terminal: false,
      engineVersion: ENGINE_VERSION,
      imageDigest: null,
    });
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
    // A running build's log is withheld: the tail exists to diagnose a
    // FINISHED build, not to be re-sent in full on every poll.
    expect(body.logTail).toBeNull();
    expect(body.error).toBeNull();
  });

  it("answers a CLI session in the same organization", async () => {
    const response = await readBuild(buildId, ownerToken);
    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({
      id: buildId,
    });
  });

  it("hides the build from another organization's session", async () => {
    const response = await readBuild(buildId, outsiderToken);
    // 404, not 403: a build id is something this API handed out, so confirming
    // one exists in a tenant the caller cannot see would be an oracle.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "build_not_found" });
  });

  it("hides the build from another environment's publish token", async () => {
    const other = await tokens.mint({ environmentId: envB });
    const response = await readBuild(buildId, other.token);
    expect(response.status).toBe(404);
  });

  it("tells an in-org member their role is the problem", async () => {
    const response = await readBuild(buildId, memberToken);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_role" });
  });

  it("answers 404 for an unknown or malformed build id", async () => {
    expect((await readBuild(randomUUID(), publishToken)).status).toBe(404);
    expect((await readBuild("not-a-uuid", publishToken)).status).toBe(404);
  });

  it("releases the log tail and the reason once the build is terminal", async () => {
    await buildService.appendLog({ buildId, chunk: "npm ERR! it broke\n" });
    await buildService.transition({
      buildId,
      to: "failed",
      error: "preflight refused the image",
    });

    const body = (await (await readBuild(buildId, publishToken)).json()) as {
      status: string;
      terminal: boolean;
      logTail: string;
      error: string;
    };
    expect(body.status).toBe("failed");
    expect(body.terminal).toBe(true);
    expect(body.logTail).toContain("npm ERR! it broke");
    expect(body.error).toBe("preflight refused the image");
  });
});
