import type { JSX } from "react";
import { changePasswordAction } from "@/app/settings/actions";
import { Card } from "@/components/ds/card";
import { Field, Input } from "@/components/ds/field";
import { Section, SectionHeading } from "@/components/ds/section";
import { ActionForm } from "./action-form";

/**
 * The signed-in user's own account: the address the control plane reaches them
 * at, and the password. The email is display-only — changing it would move
 * every pending invitation and audit actor with it, which is not this PRD.
 */
export function AccountSection({ email }: { email: string }): JSX.Element {
  return (
    <Section containerClassName="flex flex-col gap-5">
      <SectionHeading
        eyebrow="Account"
        title="Your sign-in"
        subtitle="This is the account you are signed in as, not the organization."
      />

      <Card className="flex flex-col gap-2">
        <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
          Email
        </span>
        <span className="text-sm text-white/60">{email}</span>
        <p className="text-white/40 text-xs leading-5">
          Invitations and verification codes are sent here.
        </p>
      </Card>

      <Card className="flex flex-col gap-4">
        <h3 className="font-medium text-base text-white tracking-[-0.02em]">
          Change password
        </h3>
        <ActionForm
          action={changePasswordAction}
          submitLabel="Change password"
          pendingLabel="Changing…"
          variant="solid"
        >
          <div className="flex flex-col gap-4 sm:flex-row">
            <Field
              htmlFor="current-password"
              label="Current password"
              className="flex-1"
            >
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field
              htmlFor="new-password"
              label="New password"
              hint="At least 8 characters."
              className="flex-1"
            >
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
          </div>
          <p className="text-white/40 text-xs leading-5">
            Changing the password signs out every other session.
          </p>
        </ActionForm>
      </Card>
    </Section>
  );
}
