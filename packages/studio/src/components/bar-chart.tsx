import { formatDate } from "@/lib/format";

export type BarChartPoint = {
  date: string;
  value: number;
};

/**
 * Dependency-free vertical bar chart. Good enough for the per-template send
 * series — bars scale to the max value, with hover titles for exact counts.
 */
export function BarChart({
  data,
  height = 160,
  label = "value",
}: {
  data: BarChartPoint[];
  height?: number;
  label?: string;
}) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-white/15 text-sm text-white/50"
        style={{ height }}
      >
        No data in range
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="space-y-2">
      {/* Columns must STRETCH to the container height (no items-end) or the
          bars' percentage heights resolve against an auto-height parent and
          collapse to zero. */}
      <div
        className="flex gap-1 rounded-md border border-hairline-faint bg-white/[0.015] p-3"
        style={{ height }}
      >
        {data.map((point) => {
          const pct = (point.value / max) * 100;
          return (
            <div
              key={point.date}
              className="group flex flex-1 flex-col items-center justify-end"
              title={`${formatDate(point.date)}: ${point.value} ${label}`}
            >
              <div
                className="w-full min-w-[2px] rounded-t bg-white/15 transition-colors duration-200 group-hover:bg-accent"
                style={{ height: `${Math.max(pct, point.value > 0 ? 4 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] text-white/40 uppercase tracking-[0.04em]">
        <span>{formatDate(data[0]?.date)}</span>
        <span>{formatDate(data[data.length - 1]?.date)}</span>
      </div>
    </div>
  );
}
