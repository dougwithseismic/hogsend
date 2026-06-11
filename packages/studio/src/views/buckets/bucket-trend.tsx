import { useQuery } from "@tanstack/react-query";
import { BarChart } from "@/components/bar-chart";
import { ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getBucketTrend, qk } from "@/lib/admin-api";
import { formatNumber } from "@/lib/format";

/**
 * Size-over-time + entered/left trend for a single bucket. Read-only: it merely
 * visualizes the membership transitions the engine already materialized. Reuses
 * the dependency-free BarChart (one series for joins, one for leaves) since a
 * bucket's "funnel" is really two opposing flows, not a step funnel.
 */
export function BucketTrend({ bucketId }: { bucketId: string }) {
  const query = useQuery({
    queryKey: qk.bucketTrend(bucketId),
    queryFn: () => getBucketTrend(bucketId),
  });

  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const d = query.data;
  const enteredPoints = d.points.map((p) => ({
    date: p.date,
    value: p.entered,
  }));
  const leftPoints = d.points.map((p) => ({ date: p.date, value: p.left }));
  const totalEntered = d.points.reduce((sum, p) => sum + p.entered, 0);
  const totalLeft = d.points.reduce((sum, p) => sum + p.left, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-6 text-sm">
        <div className="space-y-1">
          <span className="eyebrow block text-white/50">Current size</span>
          <span className="font-display text-lg text-white">
            {formatNumber(d.size)}
          </span>
        </div>
        <div className="space-y-1">
          <span className="eyebrow block text-white/50">Entered (range)</span>
          <span className="font-display text-lg text-white">
            {formatNumber(totalEntered)}
          </span>
        </div>
        <div className="space-y-1">
          <span className="eyebrow block text-white/50">Left (range)</span>
          <span className="font-display text-lg text-white">
            {formatNumber(totalLeft)}
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <span className="eyebrow block text-white/50">Entered over time</span>
          <BarChart data={enteredPoints} label="joined" />
        </div>
        <div className="space-y-2">
          <span className="eyebrow block text-white/50">Left over time</span>
          <BarChart data={leftPoints} label="left" />
        </div>
      </div>
    </div>
  );
}
