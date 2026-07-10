import type { ReactNode } from "react";
import type { JourneyCondition, JourneyDetail } from "@/lib/admin-api";
import { formatDurationObject } from "@/lib/format";

/** Render a condition object readably: "score lte 6", else its JSON. */
function formatCondition(c: JourneyCondition): string {
  const prop = c.property ?? c.field;
  const op = c.operator ?? c.op;
  if (typeof prop === "string" && typeof op === "string") {
    return `${prop} ${op} ${JSON.stringify(c.value ?? null)}`;
  }
  return JSON.stringify(c);
}

function ConditionList({ where }: { where?: JourneyCondition[] }) {
  if (!where || where.length === 0) {
    return <span className="text-white/40">any</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {where.map((c) => (
        <code
          key={formatCondition(c)}
          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/80"
        >
          {formatCondition(c)}
        </code>
      ))}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <span className="w-24 shrink-0 text-sm text-white/50">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white/90">{children}</div>
    </div>
  );
}

/**
 * The journey's authored definition (trigger, exits, entry limit, suppress) as
 * bare rows — the caller provides the chrome (card, side panel, …).
 */
export function JourneyDefinition({ journey }: { journey: JourneyDetail }) {
  return (
    <div className="space-y-3">
      {journey.description ? (
        <p className="text-sm text-white/70">{journey.description}</p>
      ) : null}
      <MetaRow label="Trigger">
        <div className="space-y-1.5">
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-accent">
            {journey.trigger.event}
          </code>
          <ConditionList where={journey.trigger.where} />
        </div>
      </MetaRow>
      <MetaRow label="Exit on">
        {journey.exitOn && journey.exitOn.length > 0 ? (
          <div className="space-y-2">
            {journey.exitOn.map((ex) => (
              <div
                key={`${ex.event}:${JSON.stringify(ex.where ?? [])}`}
                className="space-y-1"
              >
                <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-white/80">
                  {ex.event}
                </code>
                <ConditionList where={ex.where} />
              </div>
            ))}
          </div>
        ) : (
          <span className="text-white/40">none</span>
        )}
      </MetaRow>
      <MetaRow label="Entry limit">{journey.entryLimit}</MetaRow>
      <MetaRow label="Suppress">
        {formatDurationObject(journey.suppress) ?? "none"}
      </MetaRow>
    </div>
  );
}
