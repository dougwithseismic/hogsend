import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import {
  CliDeviceCodeService,
  type DeviceCodeDecisionResult,
  type DeviceCodeRequest,
} from "../services/cli-device-codes";
import {
  type CliSessionListItem,
  CliSessionService,
  type CliSessionSummary,
} from "../services/cli-sessions";
import { NotFoundError } from "../services/errors";
import type { OrgMembersDeps } from "./org-members";
import {
  canManageMembers,
  type MemberContext,
  NotPermittedError,
  readMemberContext,
} from "./org-members";

/**
 * The dashboard half of the CLI device flow: approving a login, and listing or
 * revoking the sessions that came out of one.
 *
 * The rules live HERE, not in the server actions above them, for the reason
 * `org-members.ts` and `environment-ops.ts` state: a server action is a POST
 * endpoint anyone with a session can call, and a hidden button is not a
 * permission check. Everything below re-resolves the caller's membership from
 * the database, so a role changed in another tab is honoured rather than
 * trusted from a stale render — and so a test can prove the rule with a real
 * session and no Next request.
 *
 * The rules, in full:
 *  1. **Approval requires a signed-in dashboard user.** A user code names a
 *     request; it never authorises one. That is why every function here starts
 *     from `readMemberContext`.
 *  2. **Approval requires an explicit confirmation.** The user code is typed,
 *     never prefilled from a link, and the caller must additionally confirm
 *     they started the login. Both exist to stop the one attack a device flow
 *     has: a stranger's pending login, sent to a signed-in victim as a URL, and
 *     bound to the victim's organization in one click (RFC 8628 §5.4).
 *  3. **Approval binds the caller's ACTIVE organization.** The session gets
 *     the same tenancy the pages resolve, so a CLI can never reach an org the
 *     human who approved it was not in.
 *  4. **Any member may approve their own login.** The session carries no
 *     authority of its own — publishing re-checks the role at every use — so
 *     gating approval by role would only stop a viewer from running the
 *     read-only commands their role already allows.
 *  5. **Revoking is the session's owner, or an owner/admin.** Cutting off a
 *     machine is an operator action; cutting off YOUR OWN machine is not.
 */

export interface CliSessionOpsDeps extends OrgMembersDeps {
  db?: CloudDb;
}

/**
 * A decision the service could make, plus the one the DASHBOARD can refuse on
 * its own: an approval nobody explicitly confirmed. It is not a service concern
 * — the service is asked to bind a code to a user — so the vocabulary is
 * widened here rather than there.
 */
export type CliDeviceDecision =
  | DeviceCodeDecisionResult
  | { ok: false; reason: "not_confirmed" };

/** Every reason an approve or deny can come back refused. */
export type CliDeviceRefusal = Extract<
  CliDeviceDecision,
  { ok: false }
>["reason"];

export interface CliSessionsView {
  context: MemberContext;
  /** Live sessions for the whole organization, newest first. */
  sessions: CliSessionListItem[];
  /** Whether this caller may revoke sessions that are not their own. */
  canRevokeAny: boolean;
}

/** Everything the Settings → CLI sessions section renders. */
export async function readCliSessionsView(
  headers: Headers,
  deps: CliSessionOpsDeps = {},
): Promise<CliSessionsView> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);
  const { sessions } = await new CliSessionService(db).list({
    organizationId: context.organizationId,
  });

  return {
    context,
    sessions,
    canRevokeAny: canManageMembers(context.role),
  };
}

/**
 * Retire one session. A session id from another organization reads as "not
 * found" rather than as something the caller may not touch — the id is not
 * theirs to have, and confirming it exists elsewhere is a leak.
 */
export async function revokeCliSession(
  headers: Headers,
  input: { sessionId: string },
  deps: CliSessionOpsDeps = {},
): Promise<CliSessionSummary> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);
  const service = new CliSessionService(db);

  const existing = await service.get({
    sessionId: input.sessionId,
    organizationId: context.organizationId,
  });
  if (!existing) throw new NotFoundError("CLI session", input.sessionId);

  if (existing.userId !== context.userId && !canManageMembers(context.role)) {
    throw new NotPermittedError(
      "Only an owner or admin can revoke another member's CLI session.",
    );
  }

  return service.revoke({
    sessionId: input.sessionId,
    organizationId: context.organizationId,
    actor: context.userId,
  });
}

/** The pending request behind a user code, for the approve page to render. */
export async function describeCliDevice(
  headers: Headers,
  input: { userCode: string },
  deps: CliSessionOpsDeps = {},
): Promise<DeviceCodeRequest | null> {
  const db = deps.db ?? defaultDb;
  await readMemberContext(headers, deps);
  return new CliDeviceCodeService(db).describe({ userCode: input.userCode });
}

/**
 * Bind a pending login to the caller and their active organization.
 *
 * `confirmed` is the human saying, in as many words, that they started this
 * login themselves. It is a REFUSAL here rather than a checkbox in the form
 * because a checkbox is markup, and this function is reachable by anything with
 * a session — the same reason the role checks live here. Membership is resolved
 * FIRST so an unconfirmed approval and an unauthenticated one cannot be told
 * apart by a caller who is neither.
 */
export async function approveCliDevice(
  headers: Headers,
  input: { userCode: string; confirmed: boolean },
  deps: CliSessionOpsDeps = {},
): Promise<CliDeviceDecision> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);
  if (!input.confirmed) {
    return { ok: false, reason: "not_confirmed" };
  }
  return new CliDeviceCodeService(db).approve({
    userCode: input.userCode,
    userId: context.userId,
    organizationId: context.organizationId,
  });
}

/** Refuse a pending login. The CLI's next poll gets `denied` and stops. */
export async function denyCliDevice(
  headers: Headers,
  input: { userCode: string },
  deps: CliSessionOpsDeps = {},
): Promise<DeviceCodeDecisionResult> {
  const db = deps.db ?? defaultDb;
  const context = await readMemberContext(headers, deps);
  return new CliDeviceCodeService(db).deny({
    userCode: input.userCode,
    userId: context.userId,
    organizationId: context.organizationId,
  });
}
