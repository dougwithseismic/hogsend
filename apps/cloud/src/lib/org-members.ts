import type { CloudAuth } from "./auth";
import { auth as defaultAuth } from "./auth";
import { resolveDashboardAccess } from "./session-guard";

/**
 * The membership half of the settings page: who is in the organization, who may
 * change that, and the reads both the page and its server actions run.
 *
 * Better Auth's organization plugin owns the tables and enforces its own
 * permissions inside every endpoint. This module exists for the other half of
 * the rule: the CALLER's role is resolved once, checked before the endpoint is
 * reached, and handed to the page so it renders only controls the caller can
 * actually use. The UI gate is a courtesy; `assertCanManageMembers` is the
 * enforcement, and it runs in the action, not the component.
 */
/** Roles an invite may be sent for. `owner` is not transferable from this UI. */
export const INVITABLE_ROLES = ["member", "admin"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Roles allowed to invite, remove and re-role other members. */
const MANAGER_ROLES = new Set<string>(["owner", "admin"]);

/**
 * A member's role is stored as a comma-separated list ("owner,admin" is legal),
 * so every role test splits rather than compares.
 */
export function roleList(role: string | null | undefined): string[] {
  return (role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasRole(role: string | null | undefined, wanted: string) {
  return roleList(role).includes(wanted);
}

export function canManageMembers(role: string | null | undefined): boolean {
  return roleList(role).some((value) => MANAGER_ROLES.has(value));
}

/** Refused by a rule, not an accident — the actions turn this into a message. */
export class NotPermittedError extends Error {
  readonly code = "not_permitted";

  constructor(message = "Your role does not allow this.") {
    super(message);
    this.name = "NotPermittedError";
  }
}

export function assertCanManageMembers(role: string | null | undefined): void {
  if (!canManageMembers(role)) {
    throw new NotPermittedError(
      "Only an owner or admin can change who is in this organization.",
    );
  }
}

export type MemberView = {
  /** The `member` row id — what remove/update-role take, not the user id. */
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt: Date;
};

export type InvitationView = {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
};

export type MemberContext = {
  userId: string;
  email: string;
  organizationId: string;
  /** The caller's role in that organization, verbatim. */
  role: string;
};

export interface OrgMembersDeps {
  auth?: CloudAuth;
}

/**
 * Who the caller is, and which organization they are acting on, resolved the
 * SAME way every dashboard page resolves it.
 *
 * Deliberately not `getActiveMember`: a plain sign-in creates a session with a
 * null `activeOrganizationId` (only creating or accepting sets it), so that
 * endpoint answers "No active organization" for a user who plainly has one.
 * `resolveDashboardAccess` is the rule the pages already follow — active org if
 * the session names one it is still a member of, first membership otherwise —
 * so routing this through it keeps the page and its actions pointed at the same
 * organization.
 *
 * The membership row is re-read from the database on every call, so a role
 * changed in another tab is picked up rather than trusted from a stale render.
 */
async function readMembership(
  headers: Headers,
  deps: OrgMembersDeps,
): Promise<{ context: MemberContext; members: MemberView[] }> {
  const auth = deps.auth ?? defaultAuth;

  const session = await auth.api.getSession({ headers });
  if (!session) throw new NotPermittedError("You are not signed in.");

  const organizations = await auth.api.listOrganizations({ headers });
  const decision = resolveDashboardAccess({
    hasSession: true,
    activeOrganizationId: session.session.activeOrganizationId,
    organizations: organizations.map((org) => ({ id: org.id, name: org.name })),
  });
  if (decision.action !== "allow") {
    throw new NotPermittedError("You are not in an organization.");
  }

  const organizationId = decision.organization.id;
  const { members } = await auth.api.listMembers({
    query: { organizationId },
    headers,
  });

  const mine = members.find((row) => row.userId === session.user.id);
  if (!mine) {
    throw new NotPermittedError("You are not a member of this organization.");
  }

  return {
    context: {
      userId: session.user.id,
      email: session.user.email,
      organizationId,
      role: mine.role,
    },
    members: members.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      role: row.role,
      joinedAt: new Date(row.createdAt),
    })),
  };
}

export async function readMemberContext(
  headers: Headers,
  deps: OrgMembersDeps = {},
): Promise<MemberContext> {
  return (await readMembership(headers, deps)).context;
}

export type MembersView = {
  context: MemberContext;
  members: MemberView[];
  /** Pending invitations. Empty for a caller who cannot manage members. */
  invitations: InvitationView[];
  canManage: boolean;
};

/**
 * Everything the members section renders, in one read.
 *
 * Pending invitations are fetched only for a manager: Better Auth lets any
 * member list them, but an invitation id is also the token that accepts it, so
 * it is not handed to people who cannot act on it.
 */
export async function readMembersView(
  headers: Headers,
  deps: OrgMembersDeps = {},
): Promise<MembersView> {
  const auth = deps.auth ?? defaultAuth;
  const { context, members } = await readMembership(headers, deps);
  const canManage = canManageMembers(context.role);

  const invitations = canManage
    ? await auth.api.listInvitations({
        query: { organizationId: context.organizationId },
        headers,
      })
    : [];

  return {
    context,
    canManage,
    members,
    invitations: invitations
      .filter((invitation) => invitation.status === "pending")
      .map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role ?? "member",
        expiresAt: new Date(invitation.expiresAt),
      })),
  };
}

/**
 * The four membership mutations.
 *
 * They live here, not in the server action, so the authorization rule is
 * testable against a real session without a Next request: the action above each
 * of these is a form parser and an error formatter, nothing more. Each one
 * re-resolves the caller's role from the database and refuses before Better
 * Auth is reached — Better Auth then refuses again inside its own endpoint,
 * which is the belt to this braces.
 */

async function managerContext(
  headers: Headers,
  deps: OrgMembersDeps,
): Promise<MemberContext> {
  const context = await readMemberContext(headers, deps);
  assertCanManageMembers(context.role);
  return context;
}

export async function inviteMember(
  headers: Headers,
  input: { email: string; role: InvitableRole },
  deps: OrgMembersDeps = {},
): Promise<{ invitationId: string }> {
  const auth = deps.auth ?? defaultAuth;
  const context = await managerContext(headers, deps);

  const invitation = await auth.api.createInvitation({
    body: {
      email: input.email,
      role: input.role,
      organizationId: context.organizationId,
      // A second invite to the same address replaces the pending one rather
      // than failing — re-sending is how a lost email gets fixed.
      resend: true,
    },
    headers,
  });

  return { invitationId: invitation.id };
}

export async function revokeInvitation(
  headers: Headers,
  input: { invitationId: string },
  deps: OrgMembersDeps = {},
): Promise<void> {
  const auth = deps.auth ?? defaultAuth;
  await managerContext(headers, deps);
  await auth.api.cancelInvitation({
    body: { invitationId: input.invitationId },
    headers,
  });
}

export async function removeMember(
  headers: Headers,
  input: { memberId: string },
  deps: OrgMembersDeps = {},
): Promise<void> {
  const auth = deps.auth ?? defaultAuth;
  const context = await managerContext(headers, deps);
  await auth.api.removeMember({
    body: {
      memberIdOrEmail: input.memberId,
      organizationId: context.organizationId,
    },
    headers,
  });
}

export async function updateMemberRole(
  headers: Headers,
  input: { memberId: string; role: InvitableRole },
  deps: OrgMembersDeps = {},
): Promise<void> {
  const auth = deps.auth ?? defaultAuth;
  const context = await managerContext(headers, deps);
  await auth.api.updateMemberRole({
    body: {
      memberId: input.memberId,
      role: input.role,
      organizationId: context.organizationId,
    },
    headers,
  });
}
