import {
  formatRelative,
  formatUptime,
  statusLabel,
  statusTone,
} from "@/lib/format";
import type { Component, Health, Snapshot, WorkerComponent } from "@/lib/types";

function Dot({ tone }: { tone: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />;
}

function componentTone(status: "up" | "down"): string {
  return status === "up" ? "bg-emerald-400" : "bg-red-400";
}

function ComponentRow({
  label,
  comp,
}: {
  label: string;
  comp: Component | WorkerComponent;
}) {
  const latency = "latencyMs" in comp ? comp.latencyMs : undefined;
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="flex items-center gap-2 text-sm text-neutral-300">
        <Dot tone={componentTone(comp.status)} />
        {label}
      </span>
      <span className="text-xs text-neutral-500">
        {comp.status === "up"
          ? latency != null
            ? `${latency}ms`
            : "up"
          : "down"}
      </span>
    </div>
  );
}

function Metric({
  label,
  value,
  alert,
}: {
  label: string;
  value: number | null;
  alert?: boolean;
}) {
  return (
    <div className="rounded-lg bg-neutral-800/60 px-3 py-2.5">
      <div
        className={`text-xl font-semibold tabular-nums ${
          alert && (value ?? 0) > 0 ? "text-red-300" : "text-neutral-100"
        }`}
      >
        {value ?? "—"}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
    </div>
  );
}

function HealthBody({ health }: { health: Health }) {
  const tone = statusTone(health.status);
  const win = health.activity.windowHours;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className={`flex items-center gap-2 font-medium ${tone.text}`}>
          <Dot tone={tone.dot} />
          {statusLabel(health.status)}
        </span>
        <span className="text-xs text-neutral-500">
          v{health.version} · up {formatUptime(health.uptime)}
        </span>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
          Last {win}h
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Metric label="Sent" value={health.activity.emails.sent} />
          <Metric label="Failed" value={health.activity.emails.failed} alert />
          <Metric label="Done" value={health.activity.journeys.completed} />
          <Metric
            label="J. Failed"
            value={health.activity.journeys.failed}
            alert
          />
        </div>
      </div>

      <div className="rounded-lg border border-neutral-800 px-3 py-1">
        <ComponentRow label="Database" comp={health.components.database} />
        <ComponentRow label="Redis" comp={health.components.redis} />
        <ComponentRow label="Worker" comp={health.components.worker} />
      </div>

      {(!health.schema.engine.inSync || !health.schema.client.inSync) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Pending migrations — engine {health.schema.engine.applied ?? "?"}→
          {health.schema.engine.required ?? "?"}, client{" "}
          {health.schema.client.applied ?? "?"}→
          {health.schema.client.required ?? "?"}
        </div>
      )}
    </div>
  );
}

export function HealthDashboard({
  snapshot,
  loading,
}: {
  snapshot: Snapshot | null;
  loading: boolean;
}) {
  if (!snapshot) {
    return (
      <div className="py-10 text-center text-sm text-neutral-500">
        {loading ? "Checking…" : "No data yet"}
      </div>
    );
  }

  return (
    <div>
      {snapshot.ok && snapshot.health ? (
        <HealthBody health={snapshot.health} />
      ) : (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-200">
          <div className="font-medium">Unreachable</div>
          <div className="mt-1 text-xs text-red-300/80">
            {snapshot.error ?? "Could not reach this instance."}
          </div>
        </div>
      )}
      <div className="mt-3 text-right text-[11px] text-neutral-600">
        Checked {formatRelative(snapshot.fetchedAt)}
      </div>
    </div>
  );
}
