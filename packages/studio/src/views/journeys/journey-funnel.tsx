import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getJourneyFunnel, qk } from "@/lib/admin-api";
import { formatNumber, formatPercent } from "@/lib/format";

type Step = { label: string; value: number };

function FunnelBar({ step, base }: { step: Step; base: number }) {
  // `ratio` is a 0–1 fraction (what formatPercent expects); `pct` is the same
  // value as a 0–100 number for the bar's CSS width.
  const ratio = base > 0 ? step.value / base : 0;
  const pct = ratio * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-white/80">{step.label}</span>
        <span className="text-white/60">
          {formatNumber(step.value)}
          {base > 0 ? (
            <span className="ml-1 text-xs text-white/50">
              ({formatPercent(ratio)})
            </span>
          ) : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-white/40"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function JourneyFunnel({ journeyId }: { journeyId: string }) {
  const query = useQuery({
    queryKey: qk.journeyFunnel(journeyId),
    queryFn: () => getJourneyFunnel(journeyId),
  });

  if (query.isPending) return <Skeleton className="h-48 w-full" />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const d = query.data;
  const steps: Step[] = [
    { label: "Enrolled", value: d.enrolled },
    { label: "Email sent", value: d.emailSent },
    { label: "Opened", value: d.emailOpened },
    { label: "Clicked", value: d.emailClicked },
    { label: "Completed", value: d.completed },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {steps.map((step) => (
          <FunnelBar key={step.label} step={step} base={d.enrolled} />
        ))}
      </div>
      <div className="flex gap-4 border-t pt-3 text-sm text-white/60">
        <span>Failed: {formatNumber(d.failed)}</span>
        <span>Exited: {formatNumber(d.exited)}</span>
      </div>
    </div>
  );
}
