import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitationForm } from "@/components/cloud/accept-invitation-form";
import { Button } from "@/components/ds/button";
import { FormError } from "@/components/ds/field";
import { auth } from "@/src/lib/auth";
import { readSessionContext } from "@/src/lib/session";
import { signOutAndReturnAction } from "./actions";

export const metadata: Metadata = { title: "Accept invitation" };

/**
 * The link an invitation email points at.
 *
 * Three states, all rendered here rather than redirected between, because the
 * visitor arrived from their mailbox and a redirect chain would lose the
 * invitation id:
 *  - no session → sign in or sign up, with `next` pointing back at this page;
 *  - session, wrong address → say so, and offer the way out (sign out, return);
 *  - session, right address → the organization, the inviter, and one button.
 */

type PageProps = { params: Promise<{ id: string }> };

type InvitationSummary = {
  organizationName: string;
  inviterEmail: string;
  role: string;
};

export default async function AcceptInvitationPage({ params }: PageProps) {
  const { id } = await params;
  const session = await readSessionContext();
  const backHere = `/accept-invitation/${encodeURIComponent(id)}`;

  if (!session) {
    return (
      <AuthShell
        title="You have been invited"
        description="Sign in with the address the invitation was sent to, and you land back on this page to accept it."
      >
        <div className="flex flex-col gap-3">
          <Button
            href={`/login?next=${encodeURIComponent(backHere)}`}
            className="w-full justify-center"
          >
            Sign in
          </Button>
          <Button
            href={`/signup?next=${encodeURIComponent(backHere)}`}
            variant="outline"
            className="w-full justify-center"
          >
            Create an account
          </Button>
        </div>
      </AuthShell>
    );
  }

  let invitation: InvitationSummary | null = null;
  let failure: string | null = null;
  try {
    const found = await auth.api.getInvitation({
      query: { id },
      headers: await headers(),
    });
    invitation = {
      organizationName: found.organizationName,
      inviterEmail: found.inviterEmail,
      role: found.role ?? "member",
    };
  } catch (error) {
    const body = (error as { body?: { message?: unknown } } | null)?.body;
    failure =
      typeof body?.message === "string"
        ? body.message
        : "This invitation could not be read.";
  }

  if (!invitation) {
    return (
      <AuthShell
        title="Invitation not available"
        description={`You are signed in as ${session.user.email}. An invitation can only be accepted by the address it was sent to.`}
      >
        <div className="flex flex-col gap-4">
          <FormError>{failure}</FormError>
          <form action={signOutAndReturnAction}>
            <input type="hidden" name="invitationId" value={id} />
            <Button type="submit" className="w-full justify-center">
              Sign out and use another address
            </Button>
          </form>
          <p className="text-center text-sm text-white/50">
            <Link href="/" className="text-white underline underline-offset-4">
              Back to the dashboard
            </Link>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join ${invitation.organizationName}`}
      description={`${invitation.inviterEmail} invited ${session.user.email} to join as ${invitation.role}.`}
    >
      <AcceptInvitationForm invitationId={id} />
    </AuthShell>
  );
}
