import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as credentialsRoute } from "../../app/api/cli/environments/[environmentId]/credentials/route";
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
import { encryptSecretPayload } from "../lib/crypto";
import { NotPermittedError } from "../lib/org-members";
import {
  REVEAL_INGEST_KEY_ACTION,
  revealIngestSnippet,
} from "../lib/tenant-access";
import { CliSessionService } from "../services/cli-sessions";

/**
 * `GET /api/cli/environments/:id/credentials` — what `hogsend env pull` reads.
 *
 * The cases here exist because this endpoint releases a LIVE credential, which
 * makes it the one CLI read where a missing check is not an inconvenience:
 *
 *  - the organization boundary is a boundary, and a foreign id reads as 404
 *    rather than as "forbidden", which would confirm it exists;
 *  - a plain `member` — who CAN list environments, and does, in the same
 *    fixture — is refused, and refused with a message about their ROLE rather
 *    than a 404 that would send them hunting a typo;
 *  - a stack that is not `running`, and a running stack with no minted key, both
 *    refuse rather than hand back a half-credential;
 *  - the audit row names the actor and the stack and contains no key material;
 *  - the SHARED gate is the same gate. Every refusal above is asserted through
 *    the browser door (`revealIngestSnippet`) too, in the same fixture, so a
 *    check deleted from `revealIngestCredentials` fails on both sides rather
 *    than being quietly lost from one.
 */

const PASSWORD = "correct-horse-12";
const OWNER = "envpull-owner@hogsend.test";
const PLAIN = "envpull-member@hogsend.test";
const OUTSIDER = "envpull-outsider@hogsend.test";
const EMAILS = [OWNER, PLAIN, OUTSIDER];

const CELL_NAME = "envpull-us-1";
const ORG_PREFIX = "EnvPullTest";

const API_URL = "https://envpull-tenant.example.test";
const INGEST_KEY = "hsk_envpull_control_plane";
const STUDIO_PASSWORD = "studio-pw-envpull-0123456789";

const auth = createCloudAuth({ emailSender: { id: "spy", async send() {} } });
const sessions = new CliSessionService(db);

let orgA = "";
let orgB = "";
let ownerId = "";
let plainId = "";
let outsiderId = "";
let readyEnv = "";
let readyStack = "";
let pendingEnv = "";
let keylessEnv = "";
let foreignEnv = "";

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
      name: `${ORG_PREFIX} ${ownerEmail}`,
      slug: `envpull-${randomUUID()}`,
    },
    headers,
  });
  if (!created) throw new Error("fixture organization not created");
  await db.insert(organizations).values({
    id: created.id,
    name: `${ORG_PREFIX} ${ownerEmail}`,
    region: "us",
    plan: "trial",
    cellId,
  });
  return created.id;
}

/** A stack exactly as the pipeline leaves one, tunable per case. */
async function seedEnvironment(
  organizationId: string,
  name: string,
  options: {
    status?: "running" | "provisioning";
    minted?: boolean;
    ingestApiKey?: string | null;
  } = {},
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
    status: options.status ?? "running",
    region: "us",
    hatchetNamespace: stackId,
    dbName: `t_envpull_${stackId.slice(0, 8)}`,
    substrateRefs: {
      substrate: "fake",
      apiPublicUrl: API_URL,
      data: {},
      credentialsMinted: options.minted ?? true,
    },
    stackSecretsEncrypted: encryptSecretPayload({
      betterAuthSecret: "b".repeat(48),
      studioAdminPassword: STUDIO_PASSWORD,
      ...(options.ingestApiKey === null
        ? {}
        : {
            ingestApiKey: options.ingestApiKey ?? INGEST_KEY,
            ingestApiKeyId: "key-control-plane",
          }),
    }),
  });
  return { environmentId: environment.id, stackId };
}

function call(environmentId: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return credentialsRoute(
    new Request(
      `http://localhost:3004/api/cli/environments/${environmentId}/credentials`,
      { headers },
    ),
    { params: Promise.resolve({ environmentId }) },
  );
}

async function tokenFor(userId: string, orgId: string): Promise<string> {
  const { token } = await sessions.create({
    userId,
    organizationId: orgId,
    label: "env-pull-test",
  });
  return token;
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(member).where(inArray(member.organizationId, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, EMAILS));
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
      sharedClusterDsn: encryptSecretPayload("postgres://x/y"),
      sharedHatchetUrl: "http://hatchet.envpull.test:8888",
      accepting: true,
      maxTenants: 100,
    })
    .returning();
  const cellId = cell?.id ?? null;

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

  orgA = await seedOrganization(OWNER, cellId);
  orgB = await seedOrganization(OUTSIDER, cellId);

  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgA,
    userId: plainId,
    role: "member",
  });

  const ready = await seedEnvironment(orgA, "production");
  readyEnv = ready.environmentId;
  readyStack = ready.stackId;
  pendingEnv = (
    await seedEnvironment(orgA, "staging", {
      status: "provisioning",
      minted: false,
    })
  ).environmentId;
  keylessEnv = (await seedEnvironment(orgA, "keyless", { ingestApiKey: null }))
    .environmentId;
  foreignEnv = (await seedEnvironment(orgB, "production")).environmentId;
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end({ timeout: 5 });
});

describe("GET /api/cli/environments/:id/credentials", () => {
  it("hands a logged-in owner the instance URL and the minted key", async () => {
    const response = await call(readyEnv, await tokenFor(ownerId, orgA));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      environmentId: string;
      apiUrl: string;
      apiKey: string;
    };
    expect(body.environmentId).toBe(readyEnv);
    expect(body.apiUrl).toBe(API_URL);
    expect(body.apiKey).toBe(INGEST_KEY);
  });

  it("refuses with no session at all", async () => {
    const response = await call(readyEnv);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(INGEST_KEY);
  });

  it("refuses a caller from another organization as a plain 404", async () => {
    // Org B's session, org A's environment. Not 403: confirming it EXISTS
    // somewhere would be the leak.
    const response = await call(readyEnv, await tokenFor(outsiderId, orgB));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");

    // And symmetrically — A cannot read B's.
    const back = await call(foreignEnv, await tokenFor(ownerId, orgA));
    expect(back.status).toBe(404);
  });

  it("refuses a plain member with a role-specific message, not a 404", async () => {
    const response = await call(readyEnv, await tokenFor(plainId, orgA));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("forbidden_role_credentials");
    // The refusal has to say WHY, or the customer reads it as a typo in the
    // environment name and never asks their admin.
    expect(body.message).toContain("member");
    expect(body.message.toLowerCase()).toContain("credentials");
    expect(JSON.stringify(body)).not.toContain(INGEST_KEY);
  });

  it("refuses a stack that is not running yet", async () => {
    const response = await call(pendingEnv, await tokenFor(ownerId, orgA));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("tenant_access_unavailable");
    expect(body.message).toContain("still being set up");
  });

  it("refuses a running stack whose key was never minted", async () => {
    const response = await call(keylessEnv, await tokenFor(ownerId, orgA));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("tenant_access_unavailable");
  });

  it("audits the release, naming the actor and never the key", async () => {
    const before = await db
      .select({ id: cloudAuditLog.id })
      .from(cloudAuditLog)
      .where(
        and(
          eq(cloudAuditLog.subject, readyStack),
          eq(cloudAuditLog.action, REVEAL_INGEST_KEY_ACTION),
        ),
      );

    const response = await call(readyEnv, await tokenFor(ownerId, orgA));
    expect(response.status).toBe(200);

    const after = await db
      .select({
        actor: cloudAuditLog.actor,
        organizationId: cloudAuditLog.organizationId,
        detail: cloudAuditLog.detail,
      })
      .from(cloudAuditLog)
      .where(
        and(
          eq(cloudAuditLog.subject, readyStack),
          eq(cloudAuditLog.action, REVEAL_INGEST_KEY_ACTION),
        ),
      );

    expect(after.length).toBe(before.length + 1);
    const row = after.at(-1);
    // The CLI caller is the HUMAN behind the session, not "system" — an audit
    // trail that could not name who pulled the key would not be one.
    expect(row?.actor).toBe(ownerId);
    expect(row?.organizationId).toBe(orgA);
    expect(JSON.stringify(row)).not.toContain(INGEST_KEY);
    expect(JSON.stringify(row)).not.toContain(STUDIO_PASSWORD);
  });
});

/**
 * The same rules, reached through the DASHBOARD's door.
 *
 * These are not a duplicate of the cases above — they are what makes the
 * extraction load-bearing. `revealIngestSnippet` (browser session) and the
 * route (CLI session) call one `revealIngestCredentials`, so if a future edit
 * drops the org scope or the role check from it, both halves of this file go
 * red rather than one of them silently passing.
 */
describe("the same gate through the browser door", () => {
  it("releases to an owner", async () => {
    const revealed = await revealIngestSnippet(await signIn(OWNER), {
      environmentId: readyEnv,
    });
    expect(revealed.apiUrl).toBe(API_URL);
    expect(revealed.snippet).toContain(`HOGSEND_API_KEY=${INGEST_KEY}`);
  });

  it("refuses another organization", async () => {
    await expect(
      revealIngestSnippet(await signIn(OUTSIDER), { environmentId: readyEnv }),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses a plain member", async () => {
    await expect(
      revealIngestSnippet(await signIn(PLAIN), { environmentId: readyEnv }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  it("refuses a stack that is not running yet", async () => {
    await expect(
      revealIngestSnippet(await signIn(OWNER), { environmentId: pendingEnv }),
    ).rejects.toThrow(/still being set up/);
  });
});
