import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
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

/** One cell of the horizontal funnel strip. */
function FunnelStripStep({
  label,
  value,
  base,
  rate,
  last,
  fail,
}: {
  label: string;
  value: number;
  base: number;
  rate?: string;
  last?: boolean;
  fail?: boolean;
}) {
  const pct = base > 0 ? Math.min((value / base) * 100, 100) : 0;
  return (
    <div className="relative border-hairline-faint border-r px-4 py-3 last:border-r-0">
      <div className="text-[11px] uppercase tracking-[0.06em] text-white/45">
        {label}
      </div>
      <div
        className={`mt-0.5 font-semibold text-xl tracking-[-0.01em] ${
          fail ? "text-accent" : "text-white/90"
        }`}
      >
        {formatNumber(value)}
      </div>
      <div className="mt-0.5 h-[11px] text-[11.5px] text-white/45">
        {rate ?? ""}
      </div>
      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent to-[#ff7a6e]"
          style={{ width: `${fail ? Math.max(pct, value > 0 ? 3 : 0) : pct}%` }}
        />
      </div>
      {last ? null : (
        <ChevronRight
          className="-right-[7px] -translate-y-1/2 absolute top-1/2 z-10 h-3.5 w-3.5 bg-raised text-white/25"
          strokeWidth={2}
        />
      )}
    </div>
  );
}

/**
 * Horizontal journey KPI strip — Enrolled → Sent → Opened → Clicked →
 * Completed → Failed with conversion rates + progress bars. Sits full-width at
 * the top of the journey detail page (works with or without a flow manifest,
 * since it reads the dedicated funnel endpoint).
 */
export function JourneyFunnelStrip({ journeyId }: { journeyId: string }) {
  const query = useQuery({
    queryKey: qk.journeyFunnel(journeyId),
    queryFn: () => getJourneyFunnel(journeyId),
  });

  if (query.isPending) return <Skeleton className="h-[92px] w-full" />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const d = query.data;
  const pctOf = (part: number, base: number) =>
    base > 0 ? formatPercent(part / base) : "—";

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-hairline-faint bg-gradient-to-b from-white/[0.03] to-white/[0.01] sm:grid-cols-3 lg:grid-cols-6">
      <FunnelStripStep label="Enrolled" value={d.enrolled} base={d.enrolled} />
      <FunnelStripStep
        label="Sent"
        value={d.emailSent}
        base={d.enrolled}
        rate={`${pctOf(d.emailSent, d.enrolled)} of enrolled`}
      />
      <FunnelStripStep
        label="Opened"
        value={d.emailOpened}
        base={d.emailSent}
        rate={`${pctOf(d.emailOpened, d.emailSent)} of sent`}
      />
      <FunnelStripStep
        label="Clicked"
        value={d.emailClicked}
        base={d.emailSent}
        rate={`${pctOf(d.emailClicked, d.emailSent)} of sent`}
      />
      <FunnelStripStep
        label="Completed"
        value={d.completed}
        base={d.enrolled}
        rate={`${pctOf(d.completed, d.enrolled)} of enrolled`}
      />
      <FunnelStripStep
        label="Failed"
        value={d.failed}
        base={d.enrolled}
        rate={pctOf(d.failed, d.enrolled)}
        fail
        last
      />
    </div>
  );
}
