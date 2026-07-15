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

/**
 * Money with its ISO currency symbol; a plain locale number when the
 * currency is absent/unknown. `maximumFractionDigits: 0` for dashboard
 * figures; leave unset where cents matter (the contact revenue drawer).
 */
export function formatCurrency(
  amount: number,
  currency: string | null,
  opts?: { maximumFractionDigits?: number },
): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        ...(opts?.maximumFractionDigits !== undefined
          ? { maximumFractionDigits: opts.maximumFractionDigits }
          : {}),
      }).format(amount);
    } catch {
      // Unknown code — fall through to the plain number.
    }
  }
  return formatNumber(
    opts?.maximumFractionDigits === 0 ? Math.round(amount) : amount,
  );
}

/**
 * "5,000 USD" — an amount labelled with its ISO CODE rather than its symbol.
 * The register for places where several currencies sit side by side and must
 * stay tellable apart (a group's per-currency revenue totals, which the revenue
 * spine forbids summing together); `formatCurrency` is the right call anywhere a
 * single currency owns the figure. A value ingested without a currency renders
 * with an explicit "(no currency)" rather than a bare number that would read as
 * the operator's own money.
 */
export function formatAmountWithCode(
  amount: number,
  currency: string | null,
): string {
  const rounded = formatNumber(Math.round(amount));
  return currency ? `${rounded} ${currency}` : `${rounded} (no currency)`;
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

/**
 * DurationObject ({ hours?, minutes?, seconds? }) → human duration, or null when
 * the duration is absent or sums to zero. Sums to seconds then delegates to
 * formatDuration (which expects seconds — never pass the object directly).
 */
export function formatDurationObject(
  d: { hours?: number; minutes?: number; seconds?: number } | null | undefined,
): string | null {
  if (!d) return null;
  const totalSecs =
    (d.hours ?? 0) * 3600 + (d.minutes ?? 0) * 60 + (d.seconds ?? 0);
  return totalSecs > 0 ? formatDuration(totalSecs) : null;
}

/** Truncate a long string with an ellipsis. */
export function truncate(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
