import type { JSX } from "react";
import { revokeCliSessionAction } from "@/app/settings/actions";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Section, SectionHeading } from "@/components/ds/section";
import type { CliSessionsView } from "@/src/lib/cli-sessions-ops";
import { ActionForm } from "./action-form";
import { TimeAgo } from "./time-ago";

/**
 * Which machines can reach this organization through the CLI, and the control
 * that cuts one off.
 *
 * `last4` rather than anything longer: it is enough for a human to match a row
 * to the terminal in front of them, and useless to anybody else. The token
 * itself was shown once, to the machine, and is stored only as a sha256 — there
 * is no read on this page that could surface one.
 *
 * The Revoke button renders for a session you own, or for anyone's if you are
 * an owner or admin. That is a courtesy, not the enforcement:
 * `revokeCliSession` re-resolves the caller's membership server-side.
 */
export function CliSessionsSection({
  view,
}: {
  view: CliSessionsView;
}): JSX.Element {
  const { sessions, context, canRevokeAny } = view;

  return (
    <Section containerClassName="flex flex-col gap-5">
      <SectionHeading
        eyebrow="CLI sessions"
        title="Machines signed in with the CLI"
        subtitle="Created by `hogsend login` and approved from this dashboard. A revoked session stops working on its next request — there is nothing to wait for and nothing to rotate."
      />

      <Card className="p-0">
        <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3 sm:grid-cols-[1.4fr_0.8fr_0.6fr_0.6fr_auto]">
          <span className="eyebrow text-white/40">Machine</span>
          <span className="eyebrow hidden text-white/40 sm:block">Member</span>
          <span className="eyebrow hidden text-white/40 sm:block">Created</span>
          <span className="eyebrow hidden text-white/40 sm:block">
            Last used
          </span>
          <span className="eyebrow text-white/40">Manage</span>
        </div>

        {sessions.length === 0 ? (
          <>
            <Hairline />
            <p className="px-5 py-6 text-sm text-white/50 leading-6">
              None. Run{" "}
              <code className="font-mono text-white/70">hogsend login</code> on
              a machine and approve the code it prints.
            </p>
          </>
        ) : null}

        {sessions.map((session) => {
          const isSelf = session.userId === context.userId;
          return (
            <div key={session.id}>
              <Hairline />
              <div className="grid grid-cols-[1fr_auto] items-start gap-4 px-5 py-4 sm:grid-cols-[1.4fr_0.8fr_0.6fr_0.6fr_auto]">
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-sm text-white tracking-[-0.02em]">
                    {session.label ?? "Unnamed machine"}
                  </span>
                  <span className="font-mono text-white/40 text-xs">
                    hscli_…{session.last4}
                  </span>
                </span>

                <span className="hidden flex-col gap-1 sm:flex">
                  <span className="text-sm text-white/70">
                    {session.userEmail}
                  </span>
                  {isSelf ? (
                    <span className="text-white/40 text-xs">you</span>
                  ) : null}
                </span>

                <span className="hidden font-mono text-white/50 text-xs sm:block">
                  {session.createdAt.toISOString().slice(0, 10)}
                </span>

                <span className="hidden text-white/50 text-xs sm:block">
                  {session.lastUsedAt ? (
                    <TimeAgo at={session.lastUsedAt} />
                  ) : (
                    "never"
                  )}
                </span>

                <span className="justify-self-end">
                  {isSelf || canRevokeAny ? (
                    <ActionForm
                      action={revokeCliSessionAction}
                      hidden={{ sessionId: session.id }}
                      submitLabel="Revoke"
                      pendingLabel="Revoking…"
                      variant="ghost"
                    />
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </Card>
    </Section>
  );
}
