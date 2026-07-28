import type { JSX } from "react";
import {
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
  updateMemberRoleAction,
} from "@/app/settings/actions";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Field, Input } from "@/components/ds/field";
import { Section, SectionHeading } from "@/components/ds/section";
import { INVITABLE_ROLES, type MembersView } from "@/src/lib/org-members";
import { ActionForm, Select } from "./action-form";

/**
 * Who is in the organization, and (for an owner or admin) the controls that
 * change it.
 *
 * `view.canManage` decides what renders; it is NOT what enforces anything —
 * every action in `app/settings/actions.ts` re-resolves the caller's role
 * server-side before it touches Better Auth.
 */
export function MembersSection({ view }: { view: MembersView }): JSX.Element {
  const { members, invitations, canManage, context } = view;

  return (
    <Section containerClassName="flex flex-col gap-5">
      <SectionHeading
        eyebrow="Members"
        title="Who can reach this organization"
        subtitle={
          canManage
            ? "Owners and admins can invite, remove and re-role members. An invitation is valid for the address it was sent to."
            : "Your role is member: you can see the list. Inviting and removing is an owner or admin action."
        }
      />

      <Card className="p-0">
        <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3 sm:grid-cols-[1.6fr_0.7fr_0.6fr_auto]">
          <span className="eyebrow text-white/40">Member</span>
          <span className="eyebrow hidden text-white/40 sm:block">Role</span>
          <span className="eyebrow hidden text-white/40 sm:block">Joined</span>
          <span className="eyebrow text-white/40">
            {canManage ? "Manage" : ""}
          </span>
        </div>
        {members.map((member) => {
          const isSelf = member.userId === context.userId;
          const isOwner = member.role.split(",").includes("owner");
          // An owner is not re-roled or removed from here: demoting the last
          // one would leave an organization nobody can administer. Leaving is
          // the account-deletion flow's job.
          const rowControls = canManage && !isSelf && !isOwner;

          return (
            <div key={member.id}>
              <Hairline />
              <div className="grid grid-cols-[1fr_auto] items-start gap-4 px-5 py-4 sm:grid-cols-[1.6fr_0.7fr_0.6fr_auto]">
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-sm text-white tracking-[-0.02em]">
                    {member.name}
                    {isSelf ? (
                      <span className="ml-2 text-white/40 text-xs">you</span>
                    ) : null}
                  </span>
                  <span className="text-white/50 text-xs">{member.email}</span>
                </span>

                <span className="hidden sm:block">
                  {rowControls ? (
                    <ActionForm
                      action={updateMemberRoleAction}
                      hidden={{ memberId: member.id }}
                      submitLabel="Save role"
                      pendingLabel="Saving…"
                      variant="ghost"
                    >
                      <Select
                        name="role"
                        defaultValue={member.role}
                        aria-label={`Role for ${member.email}`}
                      >
                        {INVITABLE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </Select>
                    </ActionForm>
                  ) : (
                    <TagPill tone={isOwner ? "accent" : "neutral"}>
                      {member.role}
                    </TagPill>
                  )}
                </span>

                <span className="hidden font-mono text-white/50 text-xs sm:block">
                  {member.joinedAt.toISOString().slice(0, 10)}
                </span>

                <span className="justify-self-end">
                  {rowControls ? (
                    <ActionForm
                      action={removeMemberAction}
                      hidden={{ memberId: member.id }}
                      submitLabel="Remove"
                      pendingLabel="Removing…"
                      variant="ghost"
                    />
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </Card>

      {canManage ? (
        <>
          <Card className="flex flex-col gap-4">
            <h3 className="font-medium text-base text-white tracking-[-0.02em]">
              Invite a member
            </h3>
            <ActionForm
              action={inviteMemberAction}
              submitLabel="Send invitation"
              pendingLabel="Sending…"
              variant="solid"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <Field
                  htmlFor="invite-email"
                  label="Email"
                  hint="The invitation can only be accepted while signed in as this address."
                  className="flex-1"
                >
                  <Input
                    id="invite-email"
                    name="email"
                    type="email"
                    autoComplete="off"
                    required
                  />
                </Field>
                <Field htmlFor="invite-role" label="Role">
                  <Select id="invite-role" name="role" defaultValue="member">
                    {INVITABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </ActionForm>
          </Card>

          <Card className="flex flex-col gap-4 p-0">
            <div className="px-6 pt-6">
              <h3 className="font-medium text-base text-white tracking-[-0.02em]">
                Pending invitations
              </h3>
              <p className="mt-1.5 text-sm text-white/50 leading-6">
                {invitations.length === 0
                  ? "None. An invitation stays here until it is accepted, revoked or expires."
                  : `${invitations.length} sent and not yet accepted.`}
              </p>
            </div>
            <div className="pb-2">
              {invitations.map((invitation) => (
                <div key={invitation.id}>
                  <Hairline />
                  <div className="flex flex-col gap-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex flex-col gap-1">
                      <span className="text-sm text-white">
                        {invitation.email}
                      </span>
                      <span className="text-white/40 text-xs">
                        role {invitation.role} · expires{" "}
                        {invitation.expiresAt.toISOString().slice(0, 10)}
                      </span>
                    </span>
                    <ActionForm
                      action={revokeInvitationAction}
                      hidden={{ invitationId: invitation.id }}
                      submitLabel="Revoke"
                      pendingLabel="Revoking…"
                      variant="ghost"
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </Section>
  );
}
