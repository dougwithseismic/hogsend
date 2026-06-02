/** Shared formatting helpers for Studio views. */

/** Render an ISO timestamp as a locale date-time, or an em dash when null. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Short date (no time) for chart axes and dense tables. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Compact relative time ("3h ago", "2d ago"). Falls back to absolute. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(iso);
}

/**
 * Backend rates are 0–1 fractions (see the engine's `rate()` helper, which the
 * CLI also renders as `value * 100`). Scale to a percent and show one decimal.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** Thousands-separated integer. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString();
}

/** Seconds → human duration ("2h 5m", "45s"). */
export function formatDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || Number.isNaN(secs)) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  const min = Math.floor(secs / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `${day}d ${remHr}h` : `${day}d`;
}

/** Truncate a long string with an ellipsis. */
export function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
