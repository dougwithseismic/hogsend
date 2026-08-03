import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { writeAudit } from "../services/audit";
import type { OrgService } from "../services/orgs";
import { orgService as defaultOrgService } from "../services/orgs";
import type { CloudAuth } from "./auth";
import { auth as defaultAuth } from "./auth";
import { hasRole } from "./org-members";

/**
 * "Delete account" has two outcomes, because an account and a tenant are not
 * the same thing (PRD 03 EARS):
 *
 *  - the SOLE OWNER of an organization is also the only person who could ever
 *    ask for that organization's data to go. Deleting the auth user would strand
 *    a tenant nobody can sign in to, so the organization is marked
 *    suspended-for-deletion and audited, and the user is signed out. Hard
 *    deletion of the tenant's data is PRD 12's flow — the UI says so.
 *  - anyone else is just a member: their membership and their user row go, and
 *    every organization they were in carries on.
 *
 * The password is verified for BOTH outcomes. Suspension stops a tenant's
 * infrastructure, so a borrowed session must not be enough to trigger it.
 */

/** The audit verb for "a human asked for this tenant to be deleted". */
export const ORG_DELETION_REQUESTED = "org.deletion_requested";

export type DeleteAccountResult =
  | { outcome: "org_suspended"; organizationIds: string[] }
  | { outcome: "account_deleted" };

export class InvalidPasswordError extends Error {
  readonly code = "invalid_password";

  constructor() {
    super("That password is not correct.");
    this.name = "InvalidPasswordError";
  }
}

export interface DeleteAccountInput {
  /** The caller's request headers — the session being acted on. */
  headers: Headers;
  password: string;
}

export interface DeleteAccountDeps {
  auth?: CloudAuth;
  orgService?: OrgService;
  db?: CloudDb;
}

/**
 * Re-check the password without disturbing the caller's session.
 *
 * `asResponse` keeps the fresh session cookie inside a Response object that is
 * read for its status and dropped, so this proves knowledge of the password and
 * changes nothing.
 */
async function verifyPassword(
  auth: CloudAuth,
  email: string,
  password: string,
): Promise<void> {
  let response: Response;
  try {
    response = await auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
  } catch {
    throw new InvalidPasswordError();
  }
  if (!response.ok) throw new InvalidPasswordError();
}

export async function deleteAccount(
  input: DeleteAccountInput,
  deps: DeleteAccountDeps = {},
): Promise<DeleteAccountResult> {
  const auth = deps.auth ?? defaultAuth;
  const orgService = deps.orgService ?? defaultOrgService;
  const db = deps.db ?? defaultDb;
  const { headers, password } = input;

  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("No signed-in user");
  const userId = session.user.id;

  await verifyPassword(auth, session.user.email, password);

  const organizations = await auth.api.listOrganizations({ headers });

  const soleOwned: string[] = [];
  for (const organization of organizations) {
    const { members } = await auth.api.listMembers({
      query: { organizationId: organization.id },
      headers,
    });
    const mine = members.find((member) => member.userId === userId);
    if (!mine || !hasRole(mine.role, "owner")) continue;
    const owners = members.filter((member) => hasRole(member.role, "owner"));
    if (owners.length === 1) soleOwned.push(organization.id);
  }

  if (soleOwned.length > 0) {
    for (const organizationId of soleOwned) {
      await orgService.suspend({ id: organizationId, actor: userId });
      await writeAudit(db, {
        actor: userId,
        organizationId,
        action: ORG_DELETION_REQUESTED,
        subject: organizationId,
        detail: {
          requestedBy: userId,
          reason: "account_deletion",
          // Suspension is the whole effect today; erasing the tenant's data is
          // an operator step (PRD 12), so the row says which one this is.
          hardDeletion: "pending_manual",
        },
      });
    }
    // The user row survives: it is the only identity that can be contacted
    // about the organization it still owns.
    await auth.api.signOut({ headers });
    return { outcome: "org_suspended", organizationIds: soleOwned };
  }

  // Cascades the `member` rows off the user, so every organization the caller
  // was in simply loses one member.
  await auth.api.deleteUser({ body: { password }, headers });
  return { outcome: "account_deleted" };
}
