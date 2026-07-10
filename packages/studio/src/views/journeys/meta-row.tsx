import type { ReactNode } from "react";
import type { JourneyCondition } from "@/lib/admin-api";
import { formatDurationObject } from "@/lib/format";

/**
 * Shared by `JourneyDefinition` and `BlueprintDefinition` — both render the
 * same authored-definition shape (trigger/exitOn conditions, labeled rows),
 * just against slightly different source objects.
 */

/** Render a condition object readably: "score lte 6", else its JSON. */
export function formatCondition(c: JourneyCondition): string {
  const prop = c.property ?? c.field;
  const op = c.operator ?? c.op;
  if (typeof prop === "string" && typeof op === "string") {
    return `${prop} ${op} ${JSON.stringify(c.value ?? null)}`;
  }
  return JSON.stringify(c);
}

export function ConditionList({ where }: { where?: JourneyCondition[] }) {
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

export function MetaRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
      <span className="w-24 shrink-0 text-sm text-white/50">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white/90">{children}</div>
    </div>
  );
}

/**
 * The authored-definition rows shared by a code journey and a blueprint
 * (trigger, exit conditions, entry limit, suppress) — both sources normalize
 * to this flat shape before rendering (a journey's trigger is nested,
 * `{event, where}`; a blueprint's is flat columns). `extra` lets a caller
 * append source-specific rows (e.g. a blueprint's provenance) without this
 * component knowing about them.
 */
export function DefinitionRows({
  description,
  triggerEvent,
  triggerWhere,
  exitOn,
  entryLimit,
  entryPeriod,
  suppress,
  extra,
}: {
  description?: string | null;
  triggerEvent: string;
  triggerWhere?: JourneyCondition[];
  exitOn?: Array<{ event: string; where?: JourneyCondition[] }> | null;
  entryLimit: string;
  /** Only meaningful (and only ever present) when entryLimit is
   * "once_per_period" — a code journey's `JourneyDetail` doesn't carry this
   * today, so it's optional. */
  entryPeriod?: Record<string, number> | null;
  suppress: Record<string, number>;
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {description ? (
        <p className="text-sm text-white/70">{description}</p>
      ) : null}
      <MetaRow label="Trigger">
        <div className="space-y-1.5">
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-accent">
            {triggerEvent}
          </code>
          <ConditionList where={triggerWhere} />
        </div>
      </MetaRow>
      <MetaRow label="Exit on">
        {exitOn && exitOn.length > 0 ? (
          <div className="space-y-2">
            {exitOn.map((ex) => (
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
      <MetaRow label="Entry limit">
        {entryLimit}
        {entryLimit === "once_per_period" && entryPeriod
          ? ` (every ${formatDurationObject(entryPeriod) ?? "—"})`
          : null}
      </MetaRow>
      <MetaRow label="Suppress">
        {formatDurationObject(suppress) ?? "none"}
      </MetaRow>
      {extra}
    </div>
  );
}
