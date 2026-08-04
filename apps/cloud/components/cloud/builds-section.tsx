import Link from "next/link";
import type { JSX } from "react";
import {
  rollbackEnvironmentAction,
  rotatePublishTokenAction,
} from "@/app/environments/actions";
import { Hairline } from "@/components/ds/decor";
import type { BuildsView } from "@/src/lib/build-views";
import { ActionForm } from "./action-form";
import { BuildStatusChip, shortDigest } from "./build-status-chip";
import { RotatePublishTokenForm } from "./rotate-publish-token-form";
import { TimeAgo } from "./time-ago";

/**
 * What this environment has published, and the credential it publishes with.
 *
 * Two cards, deliberately adjacent: the history is the answer to "did my last
 * publish land?", and the token is the thing that makes a publish possible at
 * all. Neither renders a secret — the history carries no artifact path and no
 * environment variable, and the token card carries `last4` and two dates. The
 * one moment a token is readable is the rotate action's own response, inside
 * `RotatePublishTokenForm`.
 */

/**
 * The roll-back control on one build row.
 *
 * The caveat is on the control rather than behind a confirmation dialog,
 * deliberately. What a rollback cannot undo is database migrations — they are
 * forward-only, so a column the rolled-away build added is still there
 * afterwards. A "type the name to confirm" box would imply we had that covered.
 * Saying it is the honest guard.
 */
function RollBackForm({
  environmentId,
  buildId,
}: {
  environmentId: string;
  buildId: string;
}): JSX.Element {
  return (
    <ActionForm
      action={rollbackEnvironmentAction}
      hidden={{ environmentId, buildId }}
      submitLabel="Roll back"
      pendingLabel="Rolling back…"
      variant="outline"
      className="shrink-0"
    />
  );
}

function BuildRow({
  build,
  environmentId,
  now,
  live,
  canRollBack,
}: {
  build: BuildsView["builds"][number];
  environmentId: string;
  now: Date;
  /** This is the build the stack is serving right now. */
  live: boolean;
  /** False for a member, and for a stack that is not running. */
  canRollBack: boolean;
}): JSX.Element {
  const digest = shortDigest(build.imageDigest);
  // Only a build that deployed, and not the one already on the stack. Rolling
  // back to what is running is a no-op deploy nobody meant to ask for.
  const offerRollback = canRollBack && build.status === "succeeded" && !live;

  return (
    <div className="flex items-center gap-3 py-1">
      <Link
        href={`/environments/${environmentId}/builds/${build.id}`}
        className="flex flex-1 flex-col gap-2 py-3 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      >
        <span className="flex flex-wrap items-center gap-3">
          <BuildStatusChip status={build.status} />
          {live ? (
            <span className="rounded-[40px] border border-good/40 bg-good/10 px-2 py-0.5 text-good text-xs">
              live
            </span>
          ) : null}
          <span className="text-sm text-white/80">
            {build.engineVersion
              ? `engine ${build.engineVersion}`
              : "engine version not recorded"}
          </span>
          {digest ? (
            <span className="font-mono text-white/50 text-xs">{digest}</span>
          ) : null}
        </span>
        <span className="text-sm text-white/60">
          {build.finishedAt ? (
            <>
              finished <TimeAgo at={build.finishedAt} now={now} />
            </>
          ) : (
            <>
              started <TimeAgo at={build.createdAt} now={now} />
            </>
          )}
        </span>
      </Link>

      {offerRollback ? (
        <RollBackForm environmentId={environmentId} buildId={build.id} />
      ) : null}
    </div>
  );
}

export function BuildsSection({
  environmentId,
  view,
  now,
  liveDigest,
  canRollBack,
}: {
  environmentId: string;
  view: BuildsView;
  now: Date;
  /** The digest the stack is serving, so one row can be marked live. */
  liveDigest: string | null;
  /** False for a member, and while the stack is not running. */
  canRollBack: boolean;
}): JSX.Element {
  return (
    <>
      <div className="flex flex-col gap-0">
        {/*
          One fact the drawer's own description does not carry, and that a
          customer watching two publishes needs.
        */}
        <p className="max-w-prose pb-4 text-white/50 text-xs leading-5">
          One build runs at a time: a publish sent while another is in flight
          waits its turn, so two builds can never race the same stack.
        </p>

        {/*
          The caveat belongs next to the control, not in a dialog behind it.
          Migrations are forward-only: a column the rolled-away build added is
          still there afterwards. Someone whose new code was merely wrong gets
          what they want; someone whose new code DROPPED something does not get
          it back, and has to know that before clicking.
        */}
        <p className="max-w-prose pb-4 text-white/50 text-xs leading-5">
          Rolling back re-deploys an earlier build&rsquo;s image. It does{" "}
          <span className="text-white/80">not</span> undo database migrations —
          anything a later build added to your schema stays.
        </p>

        <Hairline />

        {view.builds.length === 0 ? (
          <p className="py-6 text-sm text-white/60 leading-6">
            Nothing has been published here yet. Run{" "}
            <code className="font-mono text-white/70">hogsend publish</code>{" "}
            from the app&rsquo;s repository with this environment&rsquo;s
            publish token.
          </p>
        ) : (
          view.builds.map((build, index) => (
            <div key={build.id}>
              {index > 0 ? <Hairline /> : null}
              <BuildRow
                build={build}
                environmentId={environmentId}
                now={now}
                live={Boolean(liveDigest) && build.imageDigest === liveDigest}
                canRollBack={canRollBack}
              />
            </div>
          ))
        )}
      </div>

      <div className="mt-8 flex flex-col gap-5">
        <div>
          <h2 className="eyebrow text-white/40">Publish token</h2>
          <p className="mt-1.5 max-w-prose text-sm text-white/60 leading-6">
            The bearer credential uploads authenticate with. One was issued when
            this environment was created; it is stored hashed, so only its last
            four characters can be shown afterwards. Rotating is how you get a
            copy you can use.
          </p>
        </div>

        <Hairline />

        <div className="flex flex-col gap-5">
          <dl className="flex flex-col gap-3 sm:flex-row sm:gap-10">
            <div className="flex flex-col gap-1">
              <dt className="text-white/50 text-xs uppercase tracking-[0.08em]">
                Ends in
              </dt>
              <dd className="font-mono text-sm text-white/80">
                …{view.token.last4}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-white/50 text-xs uppercase tracking-[0.08em]">
                Issued
              </dt>
              <dd className="text-sm text-white/70">
                <TimeAgo at={view.token.createdAt} now={now} />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-white/50 text-xs uppercase tracking-[0.08em]">
                Last rotated
              </dt>
              <dd className="text-sm text-white/70">
                {view.token.rotatedAt ? (
                  <TimeAgo at={view.token.rotatedAt} now={now} />
                ) : (
                  "never"
                )}
              </dd>
            </div>
          </dl>

          {view.canRotate ? (
            <RotatePublishTokenForm
              action={rotatePublishTokenAction}
              environmentId={environmentId}
            />
          ) : (
            <p className="max-w-prose text-sm text-white/60 leading-6">
              Your role in this organization is member, so you can see which
              token this environment uses but not replace it.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
