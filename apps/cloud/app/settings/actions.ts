"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  deleteAccount,
  InvalidPasswordError,
} from "@/src/lib/account-deletion";
import type { ActionState } from "@/src/lib/action-state";
import { auth } from "@/src/lib/auth";
import { CLOUD_SESSION_COOKIE_NAME } from "@/src/lib/auth-cookie";
import { revokeCliSession } from "@/src/lib/cli-sessions-ops";
import {
  INVITABLE_ROLES,
  inviteMember,
  NotPermittedError,
  removeMember,
  revokeInvitation,
  updateMemberRole,
} from "@/src/lib/org-members";
import { NotFoundError } from "@/src/services/errors";

/**
 * Every mutation the settings page can run.
 *
 * Each one is an adapter: parse the form, call the mutation in
 * `src/lib/org-members.ts` (which re-resolves the caller's role from the
 * database and refuses before Better Auth is reached), and turn a refusal into
 * a line the form can print. A hidden button is not a permission check — these
 * are POST endpoints anyone with a session can call, so the gate lives in the
 * server, and Better Auth checks again inside its own endpoint.
 */

const OK: ActionState = { error: null, notice: null };

/**
 * Better Auth throws `APIError`, whose readable text is on `body.message`.
 * Anything else is a bug, not a rule, and gets the generic line plus a log.
 */
function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof NotPermittedError) return error.message;
  if (error instanceof InvalidPasswordError) return error.message;
  if (typeof error === "object" && error !== null) {
    const body = (error as { body?: { message?: unknown } }).body;
    if (typeof body?.message === "string") return body.message;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  console.error("[cloud] settings action failed:", error);
  return fallback;
}

const inviteSchema = z.object({
  email: z.email({ message: "Enter a valid email address." }),
  role: z.enum(INVITABLE_ROLES, { message: "Choose a role." }),
});

export async function inviteMemberAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = inviteSchema.safeParse({
    email: String(formData.get("email") ?? "")
      .trim()
      .toLowerCase(),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await inviteMember(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The invitation could not be sent.") };
  }

  revalidatePath("/settings");
  return { error: null, notice: `Invitation sent to ${parsed.data.email}.` };
}

export async function revokeInvitationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return { error: "No invitation was named." };

  try {
    await revokeInvitation(await headers(), { invitationId });
  } catch (error) {
    return {
      error: messageFrom(error, "The invitation could not be revoked."),
    };
  }

  revalidatePath("/settings");
  return OK;
}

export async function removeMemberAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const memberId = String(formData.get("memberId") ?? "");
  if (!memberId) return { error: "No member was named." };

  try {
    await removeMember(await headers(), { memberId });
  } catch (error) {
    return { error: messageFrom(error, "The member could not be removed.") };
  }

  revalidatePath("/settings");
  return OK;
}

const roleSchema = z.object({
  memberId: z.string().min(1, "No member was named."),
  role: z.enum(INVITABLE_ROLES, { message: "Choose a role." }),
});

export async function updateMemberRoleAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = roleSchema.safeParse({
    memberId: formData.get("memberId"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await updateMemberRole(await headers(), parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "The role could not be changed.") };
  }

  revalidatePath("/settings");
  return { error: null, notice: `Role set to ${parsed.data.role}.` };
}

/**
 * Cut off one machine.
 *
 * `NotFoundError` is answered with the same line whether the session belongs to
 * another organization or never existed: the id is not the caller's to have,
 * and confirming it exists somewhere else would be a leak.
 */
export async function revokeCliSessionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!sessionId) return { error: "No CLI session was named." };

  try {
    await revokeCliSession(await headers(), { sessionId });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { error: "That CLI session no longer exists." };
    }
    return { error: messageFrom(error, "The CLI session was not revoked.") };
  }

  revalidatePath("/settings");
  return { error: null, notice: "CLI session revoked." };
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(8, "The new password needs 8 characters."),
});

export async function changePasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = passwordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        // Other devices keep a session signed with the OLD password; a password
        // change is how a user reacts to one being borrowed.
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
  } catch (error) {
    return { error: messageFrom(error, "The password could not be changed.") };
  }

  return {
    error: null,
    notice: "Password changed. Other sessions signed out.",
  };
}

const deleteSchema = z.object({
  password: z.string().min(1, "Enter your password."),
  confirm: z.literal("DELETE", { message: "Type DELETE to confirm." }),
});

/**
 * Clear the session cookie by hand.
 *
 * Better Auth's server API has no Response to attach a `Set-Cookie` to, so
 * after `signOut`/`deleteUser` the browser would still hold a cookie for a
 * session row that no longer exists — and the middleware ("cookie present →
 * dashboard") would bounce the user between `/login` and `/` forever.
 */
async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(CLOUD_SESSION_COOKIE_NAME);
  jar.delete(`__Secure-${CLOUD_SESSION_COOKIE_NAME}`);
}

export async function deleteAccountAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = deleteSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }

  try {
    await deleteAccount({
      headers: await headers(),
      password: parsed.data.password,
    });
    await clearSessionCookie();
  } catch (error) {
    return { error: messageFrom(error, "The account could not be deleted.") };
  }

  // Outside the catch: `redirect` signals by throwing.
  redirect("/login");
}
