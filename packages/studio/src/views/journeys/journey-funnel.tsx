import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Filter } from "lucide-react";
import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getJourneyFunnel, getJourneyGraph, qk } from "@/lib/admin-api";
import { formatNumber, formatPercent } from "@/lib/format";

// --- Funnel geometry -------------------------------------------------------

/**
 * Terminal-state accents lifted from the flow view's NODE_STYLE so the "left
 * the journey" dots speak the same crimzon language across both views.
 */
const TERMINAL = {
  failed: "#da3633",
  exited: "#6e7681",
} as const;

type Stage = { key: string; label: string; value: number };

type Step =
  | { kind: "none" }
  | { kind: "down"; fraction: number }
  | { kind: "up"; fraction: number };

/**
 * Step conversion vs the previous stage → a drop-off (or, rarely, a gain — e.g.
 * more sends than enrollments when a journey mails a user twice, or completing
 * without clicking). `none` when the previous stage is empty, so we never print
 * a meaningless "0% drop" off a zero base.
 */
function stepFrom(current: number, prev: number): Step {
  if (prev <= 0) return { kind: "none" };
  const retained = current / prev;
  if (retained >= 1) {
    const gain = retained - 1;
    return gain < 0.0005
      ? { kind: "down", fraction: 0 }
      : { kind: "up", fraction: gain };
  }
  return { kind: "down", fraction: 1 - retained };
}

type Row = {
  key: string;
  label: string;
  value: number;
  ratio: number;
  step: Step | null;
  isFirst: boolean;
};

/** Compact drop-off (or gain) badge shown alongside each stage's percentage. */
function StepBadge({ step }: { step: Step }) {
  if (step.kind === "none") return null;
  const isUp = step.kind === "up";
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-hairline-faint bg-white/[0.015] px-1.5 py-0.5 text-[10px] tabular-nums text-white/45">
      {isUp ? (
        <ChevronUp className="h-2.5 w-2.5 text-white/40" />
      ) : (
        <ChevronDown className="h-2.5 w-2.5 text-white/40" />
      )}
      {isUp
        ? `+${formatPercent(step.fraction)}`
        : `${formatPercent(step.fraction)} drop`}
    </span>
  );
}

// --- View ------------------------------------------------------------------

export function JourneyFunnel({
  journeyId,
  hasEmail,
}: {
  journeyId: string;
  /**
   * Whether this journey has email-send stages. When omitted it's derived from
   * the journey graph (a react-query cache hit on the detail page, where
   * <JourneyFlow> already fetched `qk.journeyGraph`) OR-ed with "has it ever
   * sent?" — so a send node with zero sends still shows the (empty) email
   * stages, and a degraded/unavailable graph still expands once a send lands.
   */
  hasEmail?: boolean;
}) {
  const funnel = useQuery({
    queryKey: qk.journeyFunnel(journeyId),
    queryFn: () => getJourneyFunnel(journeyId),
  });
  // Consulted only for stage detection; never blocks render. Deduped with the
  // flow view's identical query, so it's effectively free on the detail page.
  const graph = useQuery({
    queryKey: qk.journeyGraph(journeyId),
    queryFn: () => getJourneyGraph(journeyId),
    enabled: hasEmail === undefined,
  });

  if (funnel.isPending) return <Skeleton className="h-28 w-full" />;
  if (funnel.isError) {
    return <ErrorState error={funnel.error} onRetry={() => funnel.refetch()} />;
  }

  const d = funnel.data;

  if (d.enrolled === 0) {
    return (
      <EmptyState
        icon={Filter}
        title="No enrollments yet"
        description="Once users enter this journey, their conversion funnel appears here."
      />
    );
  }

  // Structural truth: the graph has a `send` node. Ignore a degraded graph (its
  // node set is unreliable) and OR in runtime evidence so a send node with zero
  // sends still shows the email stages, while a send-less journey collapses to
  // enrolled → completed.
  const g = graph.data?.graph;
  const graphHasSend =
    g && !g.degraded ? g.nodes.some((n) => n.type === "send") : undefined;
  const showEmail = hasEmail ?? graphHasSend ?? d.emailSent > 0;

  const stages: Stage[] = [
    { key: "enrolled", label: "Enrolled", value: d.enrolled },
    ...(showEmail
      ? [
          { key: "sent", label: "Email sent", value: d.emailSent },
          { key: "opened", label: "Opened", value: d.emailOpened },
          { key: "clicked", label: "Clicked", value: d.emailClicked },
        ]
      : []),
    { key: "completed", label: "Completed", value: d.completed },
  ];

  // One pass carries the previous stage's value so each row can show its
  // step conversion (drop/gain) without the JSX reaching across array indices.
  const rows: Row[] = [];
  let prevValue: number | null = null;
  stages.forEach((stage, i) => {
    rows.push({
      key: stage.key,
      label: stage.label,
      value: stage.value,
      ratio: stage.value / d.enrolled,
      step: prevValue === null ? null : stepFrom(stage.value, prevValue),
      isFirst: i === 0,
    });
    prevValue = stage.value;
  });

  return (
    <div className="space-y-3">
      <ol className="flex items-stretch gap-2" aria-label="Conversion funnel">
        {rows.map((row) => {
          const dropLabel =
            row.step && row.step.kind !== "none"
              ? row.step.kind === "up"
                ? `, up ${formatPercent(row.step.fraction)} from previous`
                : `, ${formatPercent(row.step.fraction)} drop from previous`
              : "";
          return (
            <li
              key={row.key}
              className="min-w-0 flex-1 rounded-md border border-hairline-faint bg-white/[0.015] p-3"
              aria-label={`${row.label}: ${formatNumber(row.value)}, ${formatPercent(
                row.ratio,
              )} of enrolled${dropLabel}`}
            >
              <div className="eyebrow truncate text-white/40">{row.label}</div>
              <div className="mt-1 text-lg font-medium tabular-nums text-white/90">
                {formatNumber(row.value)}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                {row.isFirst ? (
                  <span className="eyebrow text-[10px] text-white/30">
                    base
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-white/45">
                    {formatPercent(row.ratio)}
                  </span>
                )}
                {row.step ? <StepBadge step={row.step} /> : null}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline-faint pt-3 text-xs text-white/50">
        <span className="eyebrow text-white/35">Left the journey</span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TERMINAL.failed }}
          />
          Failed {formatNumber(d.failed)}
        </span>
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TERMINAL.exited }}
          />
          Exited {formatNumber(d.exited)}
        </span>
      </div>
    </div>
  );
}
