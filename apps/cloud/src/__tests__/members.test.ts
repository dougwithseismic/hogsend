import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { cells, cloudAuditLog, organizations } from "../db/schema";
import { invitation, member, organization, user } from "../db/schema/auth";
import { env } from "../env";
import {
  deleteAccount,
  InvalidPasswordError,
  ORG_DELETION_REQUESTED,
} from "../lib/account-deletion";
import { createCloudAuth } from "../lib/auth";
import type { EmailMessage, EmailSender } from "../lib/email-sender";
import {
  canManageMembers,
  inviteMember,
  NotPermittedError,
  readMembersView,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from "../lib/org-members";
import { provisionOrganization } from "../lib/org-provision";
import { OrgService } from "../services/orgs";

/**
 * Membership authorization against the REAL database and the REAL Better Auth
 * instance.
 *
 * The whole point of these tests is that the rule holds where it is ENFORCED —
 * in the mutation functions the server actions call, with a real session — not
 * that a component hid a button. A mocked auth adapter would let a role check
 * "pass" without ever proving the invitation, the membership row or the audit
 * row landed.
 *
 * The only injected part is the email transport: a spy, so an invitation link
 * is captured in-process and no test can reach a mail provider.
 */

const PASSWORD = "correct-horse-8";
const OWNER = "members-test-owner@hogsend.test";
const INVITEE = "members-test-invitee@hogsend.test";
const SOLO = "members-test-solo@hogsend.test";
const OUTSIDER = "members-test-outsider@hogsend.test";
const EMAILS = [OWNER, INVITEE, SOLO, OUTSIDER];

const US_CELL = "members-test-us-1";
const ORG_PREFIX = "MembersTest";

const sent: EmailMessage[] = [];
const spySender: EmailSender = {
  id: "spy",
  async send(message) {
    sent.push(message);
  },
};

const auth = createCloudAuth({ emailSender: spySender });
const orgService = new OrgService(db);
const deps = { auth };
const deleteDeps = { auth, orgService, db };

/** A `cookie` header carrying a real signed-in session for `email`. */
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
    .where(like(organization.name, `${ORG_PREFIX}%`));
  const ids = authOrgs.map((row) => row.id);
  if (ids.length > 0) {
    // The mirror first: the audit log cascades off it, and it is keyed BY the
    // Better Auth id.
    await db.delete(organizations).where(inArray(organizations.id, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }
  await db.delete(user).where(inArray(user.email, EMAILS));
  await db.delete(cells).where(eq(cells.name, US_CELL));
}

/** The org ids created by this suite, resolved after setup. */
let orgA = "";
let orgB = "";

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();

  for (const email of EMAILS) {
    await auth.api.signUpEmail({
      body: { name: email.split("@")[0] as string, email, password: PASSWORD },
    });
  }

  await db.insert(cells).values({
    name: US_CELL,
    region: "us",
    sharedClusterDsn: "v1:fake-dsn",
    sharedHatchetUrl: "http://hatchet.test:7077",
    maxTenants: 10,
  });

  // Org A: OWNER owns it; INVITEE joins by invitation in the tests below.
  const a = await provisionOrganization(
    { name: `${ORG_PREFIX} Alpha`, region: "us", headers: await signIn(OWNER) },
    { auth, orgService },
  );
  orgA = a.organizationId;

  // Org B: SOLO is its only owner — the sole-owner deletion case.
  const b = await provisionOrganization(
    { name: `${ORG_PREFIX} Beta`, region: "us", headers: await signIn(SOLO) },
    { auth, orgService },
  );
  orgB = b.organizationId;
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("role predicate", () => {
  it("counts owner and admin as managers, and splits multi-roles", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("member")).toBe(false);
    expect(canManageMembers("member,admin")).toBe(true);
    expect(canManageMembers(null)).toBe(false);
    // A role that merely CONTAINS "owner" is not one.
    expect(canManageMembers("downloader")).toBe(false);
  });
});

describe("invitations", () => {
  it("an owner invites, the invitee accepts, and joins THAT organization", async () => {
    const ownerHeaders = await signIn(OWNER);
    const { invitationId } = await inviteMember(
      ownerHeaders,
      { email: INVITEE, role: "member" },
      deps,
    );

    // The invitation email carries the accept link for exactly this id.
    const mail = sent.find(
      (message) =>
        message.to === INVITEE && message.text.includes(invitationId),
    );
    expect(mail).toBeDefined();
    expect(mail?.text).toContain(`/accept-invitation/${invitationId}`);

    // It shows up as pending on the owner's settings page.
    const beforeAccept = await readMembersView(ownerHeaders, deps);
    expect(beforeAccept.canManage).toBe(true);
    expect(beforeAccept.invitations.map((row) => row.email)).toContain(INVITEE);

    const inviteeHeaders = await signIn(INVITEE);
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: inviteeHeaders,
    });

    const rows = await db
      .select()
      .from(member)
      .where(eq(member.organizationId, orgA));
    const invitedUser = await db
      .select()
      .from(user)
      .where(eq(user.email, INVITEE));
    const joined = rows.find((row) => row.userId === invitedUser[0]?.id);
    expect(joined?.role).toBe("member");

    // …and in no other organization.
    const everywhere = await db
      .select()
      .from(member)
      .where(eq(member.userId, invitedUser[0]?.id ?? ""));
    expect(everywhere.map((row) => row.organizationId)).toEqual([orgA]);

    // Accepting points the session at the organization just joined.
    const session = await auth.api.getSession({ headers: inviteeHeaders });
    expect(session?.session.activeOrganizationId).toBe(orgA);
  });

  it("refuses an invitation from a member, before Better Auth is reached", async () => {
    const memberHeaders = await signIn(INVITEE);

    await expect(
      inviteMember(memberHeaders, { email: OUTSIDER, role: "member" }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);

    // Nothing was created — the refusal is not cosmetic.
    const rows = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, orgA),
          eq(invitation.email, OUTSIDER),
        ),
      );
    expect(rows).toEqual([]);
  });

  it("refuses a revoke from a member", async () => {
    const ownerHeaders = await signIn(OWNER);
    const { invitationId } = await inviteMember(
      ownerHeaders,
      { email: OUTSIDER, role: "member" },
      deps,
    );

    await expect(
      revokeInvitation(await signIn(INVITEE), { invitationId }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);

    const [row] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    expect(row?.status).toBe("pending");

    // The owner can, and it is really cancelled.
    await revokeInvitation(ownerHeaders, { invitationId }, deps);
    const [after] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    expect(after?.status).toBe("canceled");
  });

  it("hides pending invitations from a member's view", async () => {
    const view = await readMembersView(await signIn(INVITEE), deps);
    expect(view.canManage).toBe(false);
    expect(view.invitations).toEqual([]);
    // The member list itself is visible to everyone in the org.
    expect(view.members.map((row) => row.email).sort()).toEqual(
      [INVITEE, OWNER].sort(),
    );
  });
});

describe("member mutations", () => {
  it("refuses remove and re-role from a member, and allows them for the owner", async () => {
    const ownerHeaders = await signIn(OWNER);
    const memberHeaders = await signIn(INVITEE);

    const view = await readMembersView(ownerHeaders, deps);
    const target = view.members.find((row) => row.email === INVITEE);
    if (!target) throw new Error("the invitee is not a member of org A");

    await expect(
      removeMember(memberHeaders, { memberId: target.id }, deps),
    ).rejects.toBeInstanceOf(NotPermittedError);
    await expect(
      updateMemberRole(
        memberHeaders,
        { memberId: target.id, role: "admin" },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotPermittedError);

    // Still a member, still `member`.
    const [untouched] = await db
      .select()
      .from(member)
      .where(eq(member.id, target.id));
    expect(untouched?.role).toBe("member");

    // The owner's identical calls land.
    await updateMemberRole(
      ownerHeaders,
      { memberId: target.id, role: "admin" },
      deps,
    );
    const [promoted] = await db
      .select()
      .from(member)
      .where(eq(member.id, target.id));
    expect(promoted?.role).toBe("admin");

    await removeMember(ownerHeaders, { memberId: target.id }, deps);
    const [gone] = await db
      .select()
      .from(member)
      .where(eq(member.id, target.id));
    expect(gone).toBeUndefined();
  });
});

describe("account deletion", () => {
  it("refuses a wrong password without touching anything", async () => {
    await expect(
      deleteAccount(
        { headers: await signIn(SOLO), password: "wrong-horse-8" },
        deleteDeps,
      ),
    ).rejects.toBeInstanceOf(InvalidPasswordError);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgB));
    expect(org?.suspendedAt).toBeNull();
  });

  it("a non-sole-owner loses their membership; the organization stands", async () => {
    // OUTSIDER joins org A as a member, then deletes their account.
    const ownerHeaders = await signIn(OWNER);
    const { invitationId } = await inviteMember(
      ownerHeaders,
      { email: OUTSIDER, role: "member" },
      deps,
    );
    const outsiderHeaders = await signIn(OUTSIDER);
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: outsiderHeaders,
    });

    const [outsiderUser] = await db
      .select()
      .from(user)
      .where(eq(user.email, OUTSIDER));
    const outsiderId = outsiderUser?.id ?? "";

    const result = await deleteAccount(
      { headers: outsiderHeaders, password: PASSWORD },
      deleteDeps,
    );
    expect(result.outcome).toBe("account_deleted");

    // The user and their membership are gone.
    expect(await db.select().from(user).where(eq(user.id, outsiderId))).toEqual(
      [],
    );
    expect(
      await db.select().from(member).where(eq(member.userId, outsiderId)),
    ).toEqual([]);

    // The organization is untouched: still there, still not suspended, still
    // has its owner.
    const [orgRow] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgA));
    expect(orgRow?.suspendedAt).toBeNull();
    const remaining = await db
      .select()
      .from(member)
      .where(eq(member.organizationId, orgA));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.role).toBe("owner");
  });

  it("a sole owner suspends the organization and is audited, not deleted", async () => {
    const soloHeaders = await signIn(SOLO);

    const result = await deleteAccount(
      { headers: soloHeaders, password: PASSWORD },
      deleteDeps,
    );
    expect(result).toEqual({
      outcome: "org_suspended",
      organizationIds: [orgB],
    });

    const [orgRow] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgB));
    expect(orgRow?.suspendedAt).toBeInstanceOf(Date);

    const audit = await db
      .select()
      .from(cloudAuditLog)
      .where(
        and(
          eq(cloudAuditLog.organizationId, orgB),
          eq(cloudAuditLog.action, ORG_DELETION_REQUESTED),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.subject).toBe(orgB);
    expect(audit[0]?.detail).toMatchObject({
      reason: "account_deletion",
      hardDeletion: "pending_manual",
    });

    // The sign-in survives — it is the only identity attached to the org — and
    // the session that asked is gone.
    const [soloUser] = await db.select().from(user).where(eq(user.email, SOLO));
    expect(soloUser).toBeDefined();
    expect(await auth.api.getSession({ headers: soloHeaders })).toBeNull();
  });
});
