import type { JSX } from "react";
import { deleteAccountAction } from "@/app/settings/actions";
import { Card } from "@/components/ds/card";
import { Field, Input } from "@/components/ds/field";
import { Section, SectionHeading } from "@/components/ds/section";
import { ActionForm } from "./action-form";

type DangerZoneProps = {
  organizationName: string;
  /** True when the caller is the ONLY owner of the active organization. */
  isSoleOwner: boolean;
};

/**
 * Account deletion, stated as what it actually does.
 *
 * The two outcomes are not a UI choice — they are decided server-side in
 * `deleteAccount` by counting owners — so the copy names both and says which
 * one applies to this caller's active organization.
 */
export function DangerZoneSection({
  organizationName,
  isSoleOwner,
}: DangerZoneProps): JSX.Element {
  return (
    <Section containerClassName="flex flex-col gap-5">
      <SectionHeading
        eyebrow="Danger zone"
        title="Delete account"
        subtitle="This cannot be undone from the dashboard."
      />

      <Card className="flex flex-col gap-4 border-accent/30">
        <ul className="flex flex-col gap-2 text-sm text-white/60 leading-6">
          <li>
            Where you are the only owner of an organization, that organization
            is marked suspended for deletion, the request is written to the
            audit log, and you are signed out. Your sign-in is kept, because it
            is the only identity attached to that organization. Erasing the
            organization&rsquo;s data is a separate operator step and is not
            automated yet.
          </li>
          <li>
            Where an organization has another owner, your membership and your
            sign-in are deleted and that organization carries on unchanged.
          </li>
          <li>
            {isSoleOwner
              ? `You are the only owner of ${organizationName}, so deleting your account suspends it.`
              : `${organizationName} has another owner, so deleting your account only removes you from it.`}{" "}
            Every other organization you belong to is judged by the same rule.
          </li>
        </ul>

        <ActionForm
          action={deleteAccountAction}
          submitLabel="Delete account"
          pendingLabel="Deleting…"
          variant="outline"
        >
          <div className="flex flex-col gap-4 sm:flex-row">
            <Field
              htmlFor="delete-password"
              label="Password"
              hint="Confirms it is you, not a borrowed session."
              className="flex-1"
            >
              <Input
                id="delete-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field
              htmlFor="delete-confirm"
              label="Type DELETE"
              hint="Exactly DELETE, in capitals."
              className="flex-1"
            >
              <Input
                id="delete-confirm"
                name="confirm"
                autoComplete="off"
                required
              />
            </Field>
          </div>
        </ActionForm>
      </Card>
    </Section>
  );
}
