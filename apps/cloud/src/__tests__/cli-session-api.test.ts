import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as environmentsRoute } from "../../app/api/cli/environments/route";
import { POST as revokeRoute } from "../../app/api/cli/session/revoke/route";
import { GET as sessionRoute } from "../../app/api/cli/session/route";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, cliSessions, environments, organizations } from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import type { EmailSender } from "../lib/email-sender";
import { provisionOrganization } from "../lib/org-provision";
import { CliSessionService } from "../services/cli-sessions";
import { OrgService } from "../services/orgs";

/**
 * The three CLI-session endpoints over the real routes and the real database:
 * `hogsend whoami`, `hogsend logout`, and the environment listing that turns
 * `--env staging` into the id the publish intake is addressed by.
 *
 * The laws these cases exist to hold, none of which a mock could certify:
 *  - a session carries no authority of its own. Remove its human from the
 *    organization and `whoami` and the environment list refuse at the very next
 *    request, with nothing rotated and nothing swept;
 *  - a revoked session fails closed everywhere — including on the logout that
 *    revoked it, which is why the CLI deletes its local entry regardless of the
 *    answer;
 *  - logout revokes ITSELF and cannot be pointed at anything else: there is no
 *    session id in the request to point;
 *  - the organization boundary is a boundary — org B's session lists org B's
 *    environments and never org A's;
 *  - no response carries a token, in any field.
 */

const PASSWORD = "correct-horse-8";
const OWNER = "cli-api-owner@hogsend.test";
const PLAIN = "cli-api-plain@hogsend.test";
const OUTSIDER = "cli-api-outsider@hogsend.test";
const EMAILS = [OWNER, PLAIN, OUTSIDER];

const US_CELL = "cli-api-us-1";
const ORG_PREFIX = "CliApiTest";

const spySender: EmailSender = { id: "spy", async send() {} };
const auth = createCloudAuth({ emailSender: spySender });
const orgService = new OrgService(db);
const sessions = new CliSessionService(db);

let orgA = "";
let orgB = "";
let ownerId = "";
let plainId = "";
let outsiderId = "";
let envA = "";
let envB = "";
let stagingA = "";

/**
 * `provisionOrganization` fires provisioning off in the background. This file
 * asserts the CLI ROUTES' shape, not provisioning, and any real pipeline run —
 * even with the substrate stubbed to hang — still mints the tenant database and
 * Hatchet namespace against this suite's fake cell DSN first, parking the stack
 * in `error` on a slow runner. So the "still requested" assertion below was a
 * race this suite happened to win locally. The honest seam is one level up:
 * `provisionOrganization` takes an `enqueueProvision` dep, and swallowing the
 * enqueue means NO background work runs at all — the stack stays `requested`
 * because nothing ever touches it. The intercepted stack ids are recorded so
 * the environments test can prove the pipeline was bypassed, not merely slow.
 */
const enqueuedStacks: string[] = [];
const swallowEnqueue = async (stackId: string): Promise<void> => {
  enqueuedStacks.push(stackId);
};

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

function authed(path: string, token?: string, method = "GET"): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost:3004${path}`, { method, headers });
}

const whoami = (token?: string) =>
  sessionRoute(authed("/api/cli/session", token));

const logout = (token?: string) =>
  revokeRoute(authed("/api/cli/session/revoke", token, "POST"));

const listEnvironments = (token?: string) =>
  environmentsRoute(authed("/api/cli/environments", token));

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
  await db.delete(cells).where(inArray(cells.name, [US_CELL]));
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
    {
      name: `${ORG_PREFIX} Alpha`,
      region: "us",
      headers: await signIn(OWNER),
      // Pin the signup policy: this suite asserts CLI ROUTE shapes, and the
      // `requested` stack below should not move when the deployment default
      // for `CLOUD_PROVISION_ON` changes.
      provision: true,
    },
    { auth, orgService, enqueueProvision: swallowEnqueue },
  );
  orgA = a.organizationId;
  envA = a.environmentId;

  const b = await provisionOrganization(
    {
      name: `${ORG_PREFIX} Beta`,
      region: "us",
      headers: await signIn(OUTSIDER),
      provision: true,
    },
    { auth, orgService, enqueueProvision: swallowEnqueue },
  );
  orgB = b.organizationId;
  envB = b.environmentId;

  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgA,
    userId: plainId,
    role: "member",
  });

  // Inserted directly rather than through `EnvironmentService.create`: a trial
  // plan allows exactly one environment, and this row exists to prove the list
  // returns MORE THAN production (and that a stack-less environment survives
  // the LEFT join), not to re-test the plan allowance.
  const [staging] = await db
    .insert(environments)
    .values({ organizationId: orgA, name: "staging", kind: "staging" })
    .returning({ id: environments.id });
  stagingA = staging?.id ?? "";
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("GET /api/cli/session", () => {
  it("names the user, the organization and the role — and no token", async () => {
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
      label: "owner-laptop",
    });

    const response = await whoami(token);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      session: { id: string; label: string; last4: string };
      user: { email: string };
      organization: { id: string; name: string };
      role: string;
    };

    expect(body.session.id).toBe(summary.id);
    expect(body.session.label).toBe("owner-laptop");
    expect(body.user.email).toBe(OWNER);
    expect(body.organization.id).toBe(orgA);
    expect(body.organization.name).toContain(ORG_PREFIX);
    expect(body.role).toBe("owner");

    // The whole document, not just the fields we thought to check.
    expect(raw).not.toContain(token);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("stamps last_used_at — a whoami is a use", async () => {
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });

    expect((await whoami(token)).status).toBe(200);

    const [row] = await db
      .select()
      .from(cliSessions)
      .where(inArray(cliSessions.id, [summary.id]));
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("refuses a missing, malformed, publish-shaped or revoked credential", async () => {
    expect((await whoami()).status).toBe(401);
    expect((await whoami("not-a-token")).status).toBe(401);
    // A real credential OF THE WRONG KIND: an hspub_ names no membership.
    expect((await whoami("hspub_deadbeef")).status).toBe(401);

    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });
    await sessions.revoke({ sessionId: summary.id, organizationId: orgA });
    expect((await whoami(token)).status).toBe(401);
  });

  it("refuses a session whose human left the organization — no rotation needed", async () => {
    const { token } = await sessions.create({
      userId: plainId,
      organizationId: orgA,
    });
    expect((await whoami(token)).status).toBe(200);

    const rows = await db
      .select({ id: member.id })
      .from(member)
      .where(inArray(member.userId, [plainId]));
    await db.delete(member).where(
      inArray(
        member.id,
        rows.map((row) => row.id),
      ),
    );

    const response = await whoami(token);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe(
      "forbidden_organization",
    );

    // Put them back for the cases that follow.
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgA,
      userId: plainId,
      role: "member",
    });
  });
});

describe("POST /api/cli/session/revoke", () => {
  it("revokes the calling session and nothing else", async () => {
    const mine = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });
    const theirs = await sessions.create({
      userId: plainId,
      organizationId: orgA,
    });

    const response = await logout(mine.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revoked: boolean;
      sessionId: string;
    };
    expect(body.revoked).toBe(true);
    expect(body.sessionId).toBe(mine.summary.id);

    // Fails closed at the very next use...
    expect((await whoami(mine.token)).status).toBe(401);
    // ...and the other machine in the same org is untouched.
    expect((await whoami(theirs.token)).status).toBe(200);
  });

  it("answers 401 on a second logout — already gone reads as invalid", async () => {
    const { token } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });
    expect((await logout(token)).status).toBe(200);
    expect((await logout(token)).status).toBe(401);
  });

  it("still works for a human who was removed from the organization", async () => {
    const { token } = await sessions.create({
      userId: outsiderId,
      // A session bound to an org the user is not a member of: the shape a
      // removal leaves behind.
      organizationId: orgA,
    });
    // whoami refuses it...
    expect((await whoami(token)).status).toBe(403);
    // ...but the machine can still cut itself off.
    expect((await logout(token)).status).toBe(200);
  });
});

describe("GET /api/cli/environments", () => {
  it("lists the session organization's environments with stack state", async () => {
    const { token } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });

    const response = await listEnvironments(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      organization: { id: string };
      environments: {
        id: string;
        name: string;
        kind: string;
        stackStatus: string | null;
        engineVersion: string | null;
      }[];
    };

    expect(body.organization.id).toBe(orgA);
    const ids = body.environments.map((row) => row.id);
    expect(ids).toContain(envA);
    expect(ids).toContain(stagingA);
    expect(ids).not.toContain(envB);

    const production = body.environments.find((row) => row.id === envA);
    expect(production?.kind).toBe("production");
    // A freshly created stack is `requested` and has deployed nothing. This
    // suite creates its orgs under `provision: true` (the
    // `CLOUD_PROVISION_ON=signup` policy) so the status here is about the CLI
    // route's projection, not about which policy is configured. Deterministic
    // BECAUSE the enqueue was intercepted (one per org, proven here) — no
    // pipeline ever ran to move the stack off `requested`.
    expect(enqueuedStacks).toHaveLength(2);
    expect(production?.stackStatus).toBe("requested");
    expect(production?.engineVersion).toBeNull();
  });

  it("is a READ — a member who may not publish may still list", async () => {
    const { token } = await sessions.create({
      userId: plainId,
      organizationId: orgA,
    });
    const response = await listEnvironments(token);
    expect(response.status).toBe(200);
  });

  it("never crosses the organization boundary", async () => {
    const { token } = await sessions.create({
      userId: outsiderId,
      organizationId: orgB,
    });
    const response = await listEnvironments(token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { environments: { id: string }[] };
    const ids = body.environments.map((row) => row.id);
    expect(ids).toContain(envB);
    expect(ids).not.toContain(envA);
  });

  it("refuses a revoked session", async () => {
    const { token, summary } = await sessions.create({
      userId: ownerId,
      organizationId: orgA,
    });
    await sessions.revoke({ sessionId: summary.id, organizationId: orgA });
    expect((await listEnvironments(token)).status).toBe(401);
  });
});
