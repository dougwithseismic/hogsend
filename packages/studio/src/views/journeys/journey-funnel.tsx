import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getJourneyFunnel, qk } from "@/lib/admin-api";
import { formatNumber, formatPercent } from "@/lib/format";

type Step = { label: string; value: number };

function FunnelBar({ step, base }: { step: Step; base: number }) {
  const pct = base > 0 ? (step.value / base) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{step.label}</span>
        <span className="text-muted-foreground">
          {formatNumber(step.value)}
          {base > 0 ? (
            <span className="ml-1 text-xs">({formatPercent(pct)})</span>
          ) : null}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
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
      <div className="flex gap-4 border-t pt-3 text-sm text-muted-foreground">
        <span>Failed: {formatNumber(d.failed)}</span>
        <span>Exited: {formatNumber(d.exited)}</span>
      </div>
    </div>
  );
}
