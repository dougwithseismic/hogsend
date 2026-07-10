import { ChevronDown, ChevronUp } from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/format";

/**
 * Shared funnel geometry — the stage-card strip used by the journey funnel and
 * the campaign delivery funnel, so both read in the same crimzon language.
 * Ratios are computed against the FIRST stage (the base).
 */
export type FunnelStage = { key: string; label: string; value: number };

type Step =
  | { kind: "none" }
  | { kind: "down"; fraction: number }
  | { kind: "up"; fraction: number };

/**
 * Step conversion vs the previous stage → a drop-off (or, rarely, a gain —
 * e.g. more sends than enrollments when a journey mails a user twice). `none`
 * when the previous stage is empty, so we never print a meaningless "0% drop"
 * off a zero base.
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

export function FunnelStages({
  stages,
  ariaLabel = "Conversion funnel",
}: {
  stages: FunnelStage[];
  ariaLabel?: string;
}) {
  const base = stages[0]?.value ?? 0;

  // One pass carries the previous stage's value so each card can show its
  // step conversion (drop/gain) without the JSX reaching across array indices.
  let prevValue: number | null = null;
  const rows = stages.map((stage, i) => {
    const row = {
      ...stage,
      ratio: base > 0 ? stage.value / base : 0,
      step: prevValue === null ? null : stepFrom(stage.value, prevValue),
      isFirst: i === 0,
    };
    prevValue = stage.value;
    return row;
  });

  return (
    <ol className="flex items-stretch gap-2" aria-label={ariaLabel}>
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
            )} of ${rows[0]?.label.toLowerCase()}${dropLabel}`}
          >
            <div className="eyebrow truncate text-white/40">{row.label}</div>
            <div className="mt-1 text-lg font-medium tabular-nums text-white/90">
              {formatNumber(row.value)}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              {row.isFirst ? (
                <span className="eyebrow text-[10px] text-white/30">base</span>
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
  );
}

/**
 * The dotted footnote strip under a funnel — counts that LEFT the funnel
 * (failed/exited a journey, skipped/bounced a campaign) with per-item accent
 * dots lifted from the flow view's node rails.
 */
export function FunnelNotes({
  label,
  items,
}: {
  label: string;
  items: { key: string; label: string; value: number; color: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-hairline-faint pt-3 text-xs text-white/50">
      <span className="eyebrow text-white/35">{label}</span>
      {items.map((item) => (
        <span
          key={item.key}
          className="inline-flex items-center gap-1.5 tabular-nums"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label} {formatNumber(item.value)}
        </span>
      ))}
    </div>
  );
}
