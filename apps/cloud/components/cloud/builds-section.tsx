import Link from "next/link";
import type { JSX } from "react";
import { rotatePublishTokenAction } from "@/app/environments/actions";
import { CARD_BARE, Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { cn } from "@/lib/cn";
import type { BuildsView } from "@/src/lib/build-views";
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

function BuildRow({
  build,
  environmentId,
  now,
}: {
  build: BuildsView["builds"][number];
  environmentId: string;
  now: Date;
}): JSX.Element {
  const digest = shortDigest(build.imageDigest);

  return (
    <Link
      href={`/environments/${environmentId}/builds/${build.id}`}
      className="flex flex-col gap-2 px-6 py-4 transition-colors hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <span className="flex flex-wrap items-center gap-3">
        <BuildStatusChip status={build.status} />
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
  );
}

export function BuildsSection({
  environmentId,
  view,
  now,
  bare = false,
}: {
  environmentId: string;
  view: BuildsView;
  now: Date;
  /** Rendered inside a drawer, which already supplies surface and title. */
  bare?: boolean;
}): JSX.Element {
  return (
    <>
      <Card className={cn("flex flex-col gap-0 p-0", bare && CARD_BARE)}>
        <div className="px-6 pt-6 pb-5">
          <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
            Builds
          </h2>
          <p className="mt-1.5 max-w-prose text-sm text-white/60 leading-6">
            Every publish to this environment, newest first. One build runs at a
            time: a publish sent while another is in flight waits its turn, so
            two builds can never race the same stack.
          </p>
        </div>

        <Hairline />

        {view.builds.length === 0 ? (
          <p className="px-6 py-6 text-sm text-white/60 leading-6">
            Nothing has been published here yet. Run{" "}
            <code className="font-mono text-white/70">hogsend publish</code>{" "}
            from the app&rsquo;s repository with this environment&rsquo;s
            publish token.
          </p>
        ) : (
          view.builds.map((build, index) => (
            <div key={build.id}>
              {index > 0 ? <Hairline /> : null}
              <BuildRow build={build} environmentId={environmentId} now={now} />
            </div>
          ))
        )}
      </Card>

      <Card className={cn("flex flex-col gap-5 p-0", bare && CARD_BARE)}>
        <div className="px-6 pt-6">
          <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
            Publish token
          </h2>
          <p className="mt-1.5 max-w-prose text-sm text-white/60 leading-6">
            The bearer credential uploads authenticate with. One was issued when
            this environment was created; it is stored hashed, so only its last
            four characters can be shown afterwards. Rotating is how you get a
            copy you can use.
          </p>
        </div>

        <Hairline />

        <div className="flex flex-col gap-5 px-6 pb-6">
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
      </Card>
    </>
  );
}
