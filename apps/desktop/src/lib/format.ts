import type { Health, HealthStatus } from "./types";

export function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function statusLabel(status: HealthStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "migration_pending":
      return "Migration pending";
  }
}

/** Tailwind text/bg color tokens for a status, kept in one place. */
export function statusTone(status: HealthStatus): {
  dot: string;
  text: string;
} {
  switch (status) {
    case "healthy":
      return { dot: "bg-emerald-400", text: "text-emerald-300" };
    case "degraded":
      return { dot: "bg-red-400", text: "text-red-300" };
    case "migration_pending":
      return { dot: "bg-amber-400", text: "text-amber-300" };
  }
}

/** True when anything in the snapshot warrants the user's attention. */
export function hasFailures(health: Health): boolean {
  return (
    (health.activity.journeys.failed ?? 0) > 0 ||
    (health.activity.emails.failed ?? 0) > 0 ||
    health.components.worker.status === "down" ||
    health.status !== "healthy"
  );
}
