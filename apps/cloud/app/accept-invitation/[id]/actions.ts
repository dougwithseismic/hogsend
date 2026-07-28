"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "@/src/lib/action-state";
import { auth } from "@/src/lib/auth";
import { CLOUD_SESSION_COOKIE_NAME } from "@/src/lib/auth-cookie";

/**
 * Accept the invitation named in the form.
 *
 * Better Auth owns every rule here — the invitation must be pending, unexpired
 * and addressed to the signed-in email — so this action carries no gate of its
 * own; it turns the refusal into a line the page can print. On success the
 * plugin has already created the membership AND pointed the session at the new
 * organization, so the dashboard renders it without a switch.
 */
export async function acceptInvitationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return { error: "No invitation was named." };

  try {
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: await headers(),
    });
  } catch (error) {
    const body = (error as { body?: { message?: unknown } } | null)?.body;
    if (typeof body?.message === "string") return { error: body.message };
    console.error("[cloud] Accepting an invitation failed:", error);
    return { error: "The invitation could not be accepted." };
  }

  redirect("/");
}

/**
 * Sign out and come straight back to this invitation.
 *
 * The wrong-account case is the only dead end on this page: an invitation is
 * bound to an address, so the way out is to sign in as that address. The cookie
 * is deleted by hand because the server API has no Response to attach a
 * `Set-Cookie` to, and a stale cookie would send the visitor round the
 * middleware's "signed in → dashboard" rule instead of to the login screen.
 */
export async function signOutAndReturnAction(
  formData: FormData,
): Promise<void> {
  const invitationId = String(formData.get("invitationId") ?? "");

  await auth.api.signOut({ headers: await headers() });
  const jar = await cookies();
  jar.delete(CLOUD_SESSION_COOKIE_NAME);
  jar.delete(`__Secure-${CLOUD_SESSION_COOKIE_NAME}`);

  redirect(
    invitationId
      ? `/login?next=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`
      : "/login",
  );
}
