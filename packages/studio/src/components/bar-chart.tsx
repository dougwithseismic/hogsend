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
        className="flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
        style={{ height }}
      >
        No data in range
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="space-y-2">
      <div
        className="flex items-end gap-1 rounded-md border bg-muted/20 p-3"
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
                className="w-full min-w-[2px] rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
                style={{ height: `${Math.max(pct, point.value > 0 ? 4 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatDate(data[0]?.date)}</span>
        <span>{formatDate(data[data.length - 1]?.date)}</span>
      </div>
    </div>
  );
}
