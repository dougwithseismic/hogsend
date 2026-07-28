import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, environments, organizations, stacks } from "../db/schema";
import { member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import { createCloudAuth } from "../lib/auth";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import { provisionOrganization, slugifyOrgName } from "../lib/org-provision";
import { IllegalRegionError } from "../services/errors";
import { OrgService } from "../services/orgs";

/**
 * The org-creation path end to end, against the REAL database and the REAL
 * Better Auth instance.
 *
 * What makes this worth a real database: the whole point of
 * `provisionOrganization` is that TWO stores with no shared transaction end up
 * consistent. A mocked auth adapter would let the compensating delete "pass"
 * without ever proving that the Better Auth organization is really gone.
 */

const EMAIL = "create-org-test@hogsend.test";
const PASSWORD = "correct-horse-8";
const US_CELL = "create-org-test-us-1";
/** Every org this suite creates is named with this prefix, for cleanup. */
const ORG_PREFIX = "CreateOrgTest";

const sent: EmailMessage[] = [];
const spySender: EmailSender = {
  id: "spy",
  async send(message) {
    sent.push(message);
  },
};

const auth = createCloudAuth({ emailSender: spySender });
const orgService = new OrgService(db);

/**
 * Provisioning is INJECTED here rather than left to the default. This suite's
 * cell carries a deliberately unusable DSN, so letting the real queue run would
 * prove nothing about signup and would leave stacks parked in `error`; what
 * signup owes is the enqueue itself (PRD 04 EARS), and that is what the spy
 * records.
 */
const enqueued: string[] = [];
const enqueueProvision = async (stackId: string): Promise<void> => {
  enqueued.push(stackId);
};
const deps = { auth, orgService, enqueueProvision };

/** A `cookie` header carrying a real signed-in session. */
async function signIn(): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email: EMAIL, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("sign-in returned no cookie");
  return new Headers({ cookie });
}

async function cleanup(): Promise<void> {
  const authOrgs = await db
    .select({ id: organization.id })
    .from(organization)
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    // The mirror first: it is keyed BY the Better Auth id.
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(eq(user.email, EMAIL));
  await db.delete(cells).where(eq(cells.name, US_CELL));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await auth.api.signUpEmail({
    body: { name: "Create Org Test", email: EMAIL, password: PASSWORD },
  });
  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 5,
  });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("slugifyOrgName", () => {
  it("folds punctuation and never returns an empty slug", () => {
    expect(slugifyOrgName("Acme Rockets, Inc.")).toBe("acme-rockets-inc");
    expect(slugifyOrgName("  ")).toBe("org");
    expect(slugifyOrgName("!!!")).toBe("org");
  });
});

describe("provisionOrganization", () => {
  it("creates the Better Auth org AND the control-plane trio", async () => {
    const headers = await signIn();

    const result = await provisionOrganization(
      { name: `${ORG_PREFIX} Trio`, region: "us", plan: "trial", headers },
      deps,
    );

    // Better Auth's side: the organization and the caller's membership.
    const [authOrg] = await db
      .select()
      .from(organization)
      .where(eq(organization.id, result.organizationId));
    expect(authOrg?.name).toBe(`${ORG_PREFIX} Trio`);
    expect(authOrg?.slug).toBe("createorgtest-trio");

    const members = await db
      .select()
      .from(member)
      .where(eq(member.organizationId, result.organizationId));
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");

    // The control plane's side: mirror keyed BY the Better Auth id.
    const [mirror] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, result.organizationId));
    expect(mirror?.region).toBe("us");
    expect(mirror?.plan).toBe("trial");
    expect(mirror?.cellId).not.toBeNull();

    const envRows = await db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, result.organizationId));
    expect(envRows).toHaveLength(1);
    expect(envRows[0]?.name).toBe("production");
    expect(envRows[0]?.kind).toBe("production");

    const stackRows = await db
      .select()
      .from(stacks)
      .where(eq(stacks.organizationId, result.organizationId));
    expect(stackRows).toHaveLength(1);
    expect(stackRows[0]?.status).toBe("requested");
    expect(stackRows[0]?.id).toBe(result.stackId);

    // The new organization is what the session now looks at.
    const session = await auth.api.getSession({ headers });
    expect(session?.session.activeOrganizationId).toBe(result.organizationId);

    // PRD 04 EARS: provisioning is enqueued for the new stack, with no
    // operator action and AFTER the trio committed.
    expect(enqueued).toContain(result.stackId);
  });

  it("suffixes the slug when the base one is taken", async () => {
    const headers = await signIn();
    const result = await provisionOrganization(
      { name: `${ORG_PREFIX} Trio`, region: "us", headers },
      deps,
    );
    expect(result.slug).toMatch(/^createorgtest-trio-[0-9a-f]{6}$/);
  });

  it("deletes the Better Auth org when the trio is refused", async () => {
    const headers = await signIn();
    const before = await auth.api.listOrganizations({ headers });

    // `eu` has no accepting cell in this suite, so placement refuses a
    // shared-tier org — the ordinary way this path fails in production.
    await expect(
      provisionOrganization(
        { name: `${ORG_PREFIX} Refused`, region: "eu", plan: "trial", headers },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalRegionError);

    // The compensating delete ran: no orphan org, no orphan membership.
    const orphans = await db
      .select()
      .from(organization)
      .where(eq(organization.name, `${ORG_PREFIX} Refused`));
    expect(orphans).toEqual([]);

    const after = await auth.api.listOrganizations({ headers });
    expect(after).toHaveLength(before.length);

    // And nothing landed on the control-plane side either.
    const mirrors = await db
      .select()
      .from(organizations)
      .where(eq(organizations.name, `${ORG_PREFIX} Refused`));
    expect(mirrors).toEqual([]);
  });
});
