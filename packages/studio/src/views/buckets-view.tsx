import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DocLink } from "@/components/ui/doc-link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  type BucketListItem,
  type BucketMetric,
  getBucket,
  listBucketMetrics,
  listBuckets,
  qk,
  setBucketEnabled,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import {
  formatDuration,
  formatDurationObject,
  formatNumber,
} from "@/lib/format";
import { links } from "@/lib/links";
import { BucketTrend } from "./buckets/bucket-trend";

type Row = BucketMetric & {
  enabled: boolean;
  kind: "dynamic" | "manual";
  timeBased: boolean;
};

/**
 * Observe-only Buckets view (spec §11.3). Read-only over HTTP with exactly one
 * mutation (enable/disable). Authoring stays code-first — there is intentionally
 * NO create/edit-bucket UI. Mirrors journeys-view.tsx: merge the metrics query
 * (size / entered / left / dwell) with the enabled-flag list query by bucket id.
 */
export function BucketsView() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toggleTarget, setToggleTarget] = useState<Row | null>(null);

  const metricsQuery = useQuery({
    queryKey: qk.bucketMetrics,
    queryFn: listBucketMetrics,
  });
  const bucketsQuery = useQuery({
    queryKey: qk.buckets,
    queryFn: listBuckets,
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      setBucketEnabled(vars.id, vars.enabled),
    onSuccess: (_res, vars) => {
      toast({
        title: vars.enabled ? "Bucket enabled" : "Bucket disabled",
      });
      setToggleTarget(null);
      void queryClient.invalidateQueries({ queryKey: qk.buckets });
      void queryClient.invalidateQueries({ queryKey: qk.bucketMetrics });
    },
    onError: (error) => {
      toast({
        variant: "error",
        title: "Update failed",
        description:
          error instanceof ApiError ? error.message : "Unexpected error.",
      });
      setToggleTarget(null);
    },
  });

  const isPending = metricsQuery.isPending || bucketsQuery.isPending;
  const isError = metricsQuery.isError || bucketsQuery.isError;

  // Merge engine-config enabled flags + kind/timeBased onto the metric rows by
  // bucketId (the metrics endpoint carries size/entered/left/dwell; the list
  // endpoint carries the effective enabled flag and shape discriminators).
  const metaMap = new Map<string, BucketListItem>(
    (bucketsQuery.data?.buckets ?? []).map((b) => [b.id, b]),
  );
  const rows: Row[] = (metricsQuery.data?.buckets ?? []).map((m) => {
    const meta = metaMap.get(m.bucketId);
    return {
      ...m,
      enabled: meta?.enabled ?? false,
      kind: meta?.kind ?? "dynamic",
      timeBased: meta?.timeBased ?? false,
    };
  });

  const selected = rows.find((r) => r.bucketId === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Buckets"
        description="Real-time, code-defined membership. Sizes, enter/leave trends, and which journeys each bucket feeds — observe only, authoring stays in code."
      />

      {isPending ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState
          error={metricsQuery.error ?? bucketsQuery.error}
          onRetry={() => {
            void metricsQuery.refetch();
            void bucketsQuery.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No buckets registered"
          description="Buckets are real-time, code-defined audiences (defineBucket()). Add one to your app and members appear here as events arrive."
          action={
            <>
              <DocLink href={links.buckets}>How to create a bucket</DocLink>
              <DocLink href={links.recipes} variant="ghost">
                Recipes
              </DocLink>
            </>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead className="text-right">Current size</TableHead>
                <TableHead className="text-right">Entered</TableHead>
                <TableHead className="text-right">Left</TableHead>
                <TableHead className="text-right">Avg dwell</TableHead>
                <TableHead>Freshness</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.bucketId}
                  className="cursor-pointer"
                  data-state={
                    row.bucketId === selectedId ? "selected" : undefined
                  }
                  onClick={() =>
                    setSelectedId((cur) =>
                      cur === row.bucketId ? null : row.bucketId,
                    )
                  }
                >
                  <TableCell>
                    <span className="font-medium">{row.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {row.bucketId}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.size)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.entered)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(row.left)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDuration(row.avgDwellSecs)}
                  </TableCell>
                  <TableCell>
                    <FreshnessBadge timeBased={row.timeBased} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.enabled ? "default" : "secondary"}>
                      {row.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setToggleTarget(row);
                      }}
                    >
                      {row.enabled ? "Disable" : "Enable"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {selected.name} — feeds journeys
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BucketFeeds bucketId={selected.bucketId} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {selected.name} — enter / leave over time
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BucketTrend bucketId={selected.bucketId} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <ConfirmDialog
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        onConfirm={() =>
          toggleTarget &&
          toggle.mutate({
            id: toggleTarget.bucketId,
            enabled: !toggleTarget.enabled,
          })
        }
        title={
          toggleTarget?.enabled ? "Disable this bucket?" : "Enable this bucket?"
        }
        description={
          toggleTarget?.enabled
            ? "Membership will stop being recomputed; in-flight members stay until they leave."
            : "Matching users will start being added to this bucket again."
        }
        confirmLabel={toggleTarget?.enabled ? "Disable" : "Enable"}
        destructive={toggleTarget?.enabled}
        loading={toggle.isPending}
      />
    </div>
  );
}

/**
 * Honest "building / live" freshness badge (spec §11.3). Event-driven buckets
 * (pure property / event-existence) transition in real time on ingest → "Live".
 * Time-based buckets depend on the reconcile cron sweep for absence/decay leaves,
 * so their membership lags the cron cadence → "Building".
 */
function FreshnessBadge({ timeBased }: { timeBased: boolean }) {
  return timeBased ? (
    <Badge variant="outline" title="Time-based — leaves lag the reconcile cron">
      Building
    </Badge>
  ) : (
    <Badge variant="outline" title="Event-driven — transitions in real time">
      Live
    </Badge>
  );
}

/** Which journeys this bucket feeds, from the detail endpoint's cross-reference. */
function BucketFeeds({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: qk.bucket(bucketId),
    queryFn: () => getBucket(bucketId),
  });

  if (query.isPending) return <Skeleton className="h-10 w-full" />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const feeds = query.data.bucket.feedsJourneys;
  // maxDwell is a DurationObject ({ hours?, minutes?, seconds? }) returned by the
  // detail endpoint; render the time-box badge ABOVE the feeds early-return so it
  // surfaces even when no journeys are bound to this bucket.
  const maxDwell = formatDurationObject(
    query.data.bucket.maxDwell as
      | { hours?: number; minutes?: number; seconds?: number }
      | null
      | undefined,
  );

  return (
    <div className="space-y-3">
      {maxDwell ? (
        <Badge
          variant="outline"
          title="Members are force-removed maxDwell after joining, regardless of criteria."
        >
          Time-boxed · {maxDwell}
        </Badge>
      ) : null}

      {feeds.length === 0 ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            No journeys are bound to this bucket's transitions yet. Bind one to
            THIS bucket with the typed refs{" "}
            <code className="text-xs">bucket.entered</code> /{" "}
            <code className="text-xs">bucket.left</code> (e.g.{" "}
            <code className="text-xs">{`{ trigger: { event: bucket.entered } }`}</code>
            ), or colocate a reaction with{" "}
            <code className="text-xs">{`bucket.on("enter", ...)`}</code>.
          </p>
          <p>
            To react to ANY bucket, use the generic{" "}
            <code className="text-xs">Events.BUCKET_ENTERED</code> /{" "}
            <code className="text-xs">Events.BUCKET_LEFT</code> constants.
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {feeds.map((j) => (
            <Badge
              key={`${j.id}-${j.trigger}`}
              variant={j.owned ? "default" : "secondary"}
              title={j.trigger}
            >
              {j.name}
              {j.owned ? (
                <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-70">
                  owned
                </span>
              ) : null}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
