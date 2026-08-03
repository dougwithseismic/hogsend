import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  BuildStatusChip,
  shortDigest,
} from "@/components/cloud/build-status-chip";
import { TimeAgo } from "@/components/cloud/time-ago";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import { readBuildDetail } from "@/src/lib/build-views";
import { requireActiveOrganization } from "@/src/lib/session";

export const metadata: Metadata = {
  title: "Build",
  description: "One publish, its status and the tail of its build log.",
};

/**
 * One build: where it got to, what it produced, and the last of what it
 * printed.
 *
 * The tenancy guard is `readBuildDetail`'s — it scopes the read to the caller's
 * own organization AND to the environment in the URL, so a build id from
 * another environment (their own or someone else's) is a 404 here.
 *
 * Nothing on this page is a secret: the log tail is build output, and the
 * artifact path is deliberately NOT rendered. The digest, the engine version
 * and the timings are the whole answer to "did my publish land?".
 */

function Row({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <span className="font-medium text-sm text-white/80 tracking-[-0.02em]">
        {label}
      </span>
      <span className="text-sm text-white/60">{children}</span>
    </div>
  );
}

export default async function BuildDetailPage({
  params,
}: {
  params: Promise<{ id: string; buildId: string }>;
}) {
  await requireActiveOrganization();
  const { id, buildId } = await params;

  const build = await readBuildDetail(await headers(), {
    environmentId: id,
    buildId,
  });
  if (!build) notFound();

  const now = new Date();
  const digest = shortDigest(build.imageDigest);

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Build"
        description="One publish to this environment, from the uploaded tarball to the image it produced."
        actions={
          <Button href={`/environments/${id}`} variant="outline">
            Back to environment
          </Button>
        }
      />

      <Section divider={false} containerClassName="flex flex-col gap-4">
        <Card className="p-0">
          <Row label="Status">
            <BuildStatusChip status={build.status} />
          </Row>
          <Hairline />
          <Row label="Build id">
            <span className="font-mono text-white/70 text-xs">{build.id}</span>
          </Row>
          <Hairline />
          <Row label="Engine version">
            {build.engineVersion ?? "not recorded"}
          </Row>
          <Hairline />
          <Row label="Image digest">
            {build.imageDigest ? (
              <span
                className="font-mono text-white/70 text-xs"
                title={build.imageDigest}
              >
                {digest}
              </span>
            ) : (
              "set when the image is pushed"
            )}
          </Row>
          <Hairline />
          <Row label="Queued">
            <TimeAgo at={build.createdAt} now={now} />
          </Row>
          <Hairline />
          <Row label="Started">
            {build.startedAt ? (
              <TimeAgo at={build.startedAt} now={now} />
            ) : (
              "waiting for the builder"
            )}
          </Row>
          <Hairline />
          <Row label="Finished">
            {build.finishedAt ? (
              <TimeAgo at={build.finishedAt} now={now} />
            ) : (
              "still running"
            )}
          </Row>
        </Card>

        {build.error ? (
          <Card className="flex flex-col gap-2 border-accent/30">
            <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
              Build stopped
            </h2>
            <p className="font-mono text-sm text-white/70 leading-6">
              {build.error}
            </p>
            <p className="max-w-prose text-sm text-white/60 leading-6">
              Nothing was deployed. Fix the cause and publish again — a retry is
              a new build, with its own artifact and its own log.
            </p>
          </Card>
        ) : null}

        <Card className="flex flex-col gap-0 p-0">
          <div className="px-6 pt-6 pb-5">
            <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
              Build log
            </h2>
            <p className="mt-1.5 max-w-prose text-sm text-white/60 leading-6">
              The last 64KB of output. Earlier lines are dropped as the build
              runs, so what is kept is the part a failure is diagnosed from.
            </p>
          </div>

          <Hairline />

          {build.logTail ? (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words px-6 py-5 font-mono text-white/70 text-xs leading-5">
              {build.logTail}
            </pre>
          ) : (
            <p className="px-6 py-6 text-sm text-white/60 leading-6">
              No output yet. The log fills as the build runs.
            </p>
          )}
        </Card>
      </Section>
    </main>
  );
}
