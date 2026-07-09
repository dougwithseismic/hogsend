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

/**
 * A drawn segment never necks below this fraction (unless the stage is
 * genuinely zero) so a tiny-but-nonzero stage stays a visible neck rather than a
 * knife-edge. The same value feeds the NEXT segment's top edge, so the taper
 * stays continuous across the gap between segments.
 */
const MIN_WIDTH = 0.04;

type Stage = { key: string; label: string; value: number };

/** Clamp a value/enrolled ratio into a drawable [MIN_WIDTH, 1] band; 0 stays 0. */
function geoWidth(value: number, enrolled: number): number {
  if (enrolled <= 0 || value <= 0) return 0;
  return Math.max(MIN_WIDTH, Math.min(1, value / enrolled));
}

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
  topFrac: number;
  bottomFrac: number;
  step: Step | null;
  isFirst: boolean;
  isLast: boolean;
};

/**
 * One centered, tapering trapezoid. `topFrac`/`bottomFrac` are the 0–1 widths of
 * the top and bottom edges; a clip-path insets each edge symmetrically so the
 * band necks down from the previous stage's width to this one's. Purely
 * decorative — every number lives in the label row + the list-item aria-label.
 */
function FunnelSegment({
  topFrac,
  bottomFrac,
  emphasis,
}: {
  topFrac: number;
  bottomFrac: number;
  emphasis?: boolean;
}) {
  const top = (1 - topFrac) * 50;
  const bottom = (1 - bottomFrac) * 50;
  return (
    <div
      aria-hidden
      className="h-11 w-full"
      style={{
        clipPath: `polygon(${top}% 0, ${100 - top}% 0, ${100 - bottom}% 100%, ${bottom}% 100%)`,
        background: emphasis
          ? "linear-gradient(180deg, rgba(246,72,56,0.42), rgba(246,72,56,0.24))"
          : "linear-gradient(180deg, rgba(246,72,56,0.30), rgba(246,72,56,0.13))",
      }}
    />
  );
}

/** The between-segments drop-off pill (a faint dot when it's undefined). */
function StepConnector({ step }: { step: Step }) {
  if (step.kind === "none") {
    return (
      <div className="flex justify-center py-1" aria-hidden>
        <span className="h-1 w-1 rounded-full bg-white/15" />
      </div>
    );
  }
  const isUp = step.kind === "up";
  return (
    <div className="flex justify-center py-1.5" aria-hidden>
      <span className="inline-flex items-center gap-1 rounded-full border border-hairline-faint bg-white/[0.015] px-2 py-0.5 text-[11px] tabular-nums text-white/45">
        {isUp ? (
          <ChevronUp className="h-3 w-3 text-white/40" />
        ) : (
          <ChevronDown className="h-3 w-3 text-white/40" />
        )}
        {isUp
          ? `+${formatPercent(step.fraction)}`
          : `${formatPercent(step.fraction)} drop`}
      </span>
    </div>
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

  if (funnel.isPending) return <Skeleton className="h-56 w-full" />;
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

  // One pass builds every derived value (taper edges, ratio, step) so the JSX
  // never reaches across array indices — `noUncheckedIndexedAccess` is on.
  const rows: Row[] = [];
  let prevValue: number | null = null;
  let prevWidth = 1; // the enrolled edge starts full-width
  stages.forEach((stage, i) => {
    const width = geoWidth(stage.value, d.enrolled);
    const isFirst = i === 0;
    rows.push({
      key: stage.key,
      label: stage.label,
      value: stage.value,
      ratio: stage.value / d.enrolled,
      topFrac: isFirst ? width : prevWidth,
      bottomFrac: width,
      step: prevValue === null ? null : stepFrom(stage.value, prevValue),
      isFirst,
      isLast: i === stages.length - 1,
    });
    prevValue = stage.value;
    prevWidth = width;
  });

  return (
    <div className="space-y-4">
      <ol className="w-full" aria-label="Conversion funnel">
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
              aria-label={`${row.label}: ${formatNumber(row.value)}, ${formatPercent(
                row.ratio,
              )} of enrolled${dropLabel}`}
            >
              {row.step ? <StepConnector step={row.step} /> : null}
              <div className="flex items-baseline justify-between gap-3">
                <span className="eyebrow text-white/40">{row.label}</span>
                <span className="flex items-baseline gap-1.5 text-sm font-medium tabular-nums text-white/85">
                  {formatNumber(row.value)}
                  {row.isFirst ? (
                    <span className="eyebrow text-[10px] text-white/30">
                      base
                    </span>
                  ) : (
                    <span className="text-xs font-normal text-white/40">
                      {formatPercent(row.ratio)}
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1">
                <FunnelSegment
                  topFrac={row.topFrac}
                  bottomFrac={row.bottomFrac}
                  emphasis={row.isLast}
                />
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
