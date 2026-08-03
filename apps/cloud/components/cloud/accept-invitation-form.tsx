"use client";

import type { JSX } from "react";
import { acceptInvitationAction } from "@/app/accept-invitation/[id]/actions";
import { ActionForm } from "./action-form";

/** One button, its own pending + error state. */
export function AcceptInvitationForm({
  invitationId,
}: {
  invitationId: string;
}): JSX.Element {
  return (
    <ActionForm
      action={acceptInvitationAction}
      hidden={{ invitationId }}
      submitLabel="Accept invitation"
      pendingLabel="Joining…"
      variant="solid"
    />
  );
}
