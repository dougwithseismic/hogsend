import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import type { EnvironmentWithStack } from "@/src/services/environments";
import { StackStatusChip } from "./stack-status-chip";

/**
 * The environments list, shared by the overview and the environments page.
 *
 * Dates are rendered as ISO calendar days rather than a locale string: the
 * server and the browser would otherwise format the same timestamp differently
 * and React would flag the hydration mismatch.
 */
export function EnvironmentTable({
  environments,
}: {
  environments: EnvironmentWithStack[];
}): JSX.Element {
  return (
    <Card className="p-0">
      <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-3 sm:grid-cols-[1.4fr_0.8fr_0.6fr_auto]">
        <span className="eyebrow text-white/40">Environment</span>
        <span className="eyebrow hidden text-white/40 sm:block">Stack</span>
        <span className="eyebrow hidden text-white/40 sm:block">Created</span>
        <span className="eyebrow text-white/40">Status</span>
      </div>
      {environments.map((environment) => (
        <div key={environment.id}>
          <Hairline />
          <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4 sm:grid-cols-[1.4fr_0.8fr_0.6fr_auto]">
            <span className="flex flex-col gap-1">
              <span className="font-medium text-sm text-white tracking-[-0.02em]">
                {environment.name}
              </span>
              <span className="text-white/40 text-xs">{environment.kind}</span>
            </span>
            <span className="hidden text-sm text-white/60 sm:block">
              {environment.stack?.region ?? "—"}
            </span>
            <span className="hidden font-mono text-white/50 text-xs sm:block">
              {environment.createdAt.toISOString().slice(0, 10)}
            </span>
            <span className="justify-self-end">
              <StackStatusChip status={environment.stack?.status ?? null} />
            </span>
          </div>
        </div>
      ))}
    </Card>
  );
}
