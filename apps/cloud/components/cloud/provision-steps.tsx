import { AlertTriangle, Check, Circle, SkipForward } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { cn } from "@/lib/cn";
import {
  PROVISION_STEP_LABELS,
  type ProvisionStepState,
  type ProvisionStepView,
} from "@/src/lib/environment-detail";
import { TimeAgo } from "./time-ago";

/**
 * The provisioning run, one step per row, read off the audit trail.
 *
 * Each row leads with what the step is DOING and keeps the pipeline's own name
 * (`ensure-tenant-db`, `set-env`, …) beside it. Both are needed: the sentence is
 * the only half a customer can act on, and the slug is what `last_error` names
 * when a step fails, so someone reading "Provisioning stopped at set-env" must
 * still find that word on this page.
 *
 * `skipped` is its own state, not a shade of done. It means the pipeline found
 * a persisted artifact from an earlier attempt and did no work — which is
 * exactly what a resumed retry looks like, and the reason a retry is not a
 * re-provision.
 */

const STATE_COPY: Record<ProvisionStepState, string> = {
  done: "done",
  skipped: "skipped, already done",
  failed: "failed",
  pending: "pending",
};

const STATE_ICON: Record<ProvisionStepState, ReactNode> = {
  done: <Check aria-hidden className="size-3.5 text-good" strokeWidth={2} />,
  skipped: (
    <SkipForward
      aria-hidden
      className="size-3.5 text-white/50"
      strokeWidth={2}
    />
  ),
  failed: (
    <AlertTriangle
      aria-hidden
      className="size-3.5 text-accent"
      strokeWidth={2}
    />
  ),
  pending: (
    <Circle aria-hidden className="size-3.5 text-white/25" strokeWidth={2} />
  ),
};

const STATE_TEXT: Record<ProvisionStepState, string> = {
  done: "text-white",
  skipped: "text-white/70",
  failed: "text-white",
  pending: "text-white/40",
};

export function ProvisionSteps({
  steps,
  now,
}: {
  steps: ProvisionStepView[];
  now?: Date;
}): JSX.Element {
  const done = steps.filter(
    (step) => step.state === "done" || step.state === "skipped",
  ).length;

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-4 px-5 py-3">
        <span className="eyebrow text-white/40">Provisioning steps</span>
        <span className="font-mono text-white/50 text-xs">
          {done}/{steps.length} recorded
        </span>
      </div>
      {steps.map((step) => (
        <div key={step.step}>
          <Hairline />
          <div className="flex items-center justify-between gap-4 px-5 py-3">
            <span className="flex items-center gap-3">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-[4px] border border-white/[0.08] bg-white/[0.03]">
                {STATE_ICON[step.state]}
              </span>
              <span className="flex flex-col gap-0.5">
                <span
                  className={cn(
                    "text-sm tracking-[-0.01em]",
                    STATE_TEXT[step.state],
                  )}
                >
                  {PROVISION_STEP_LABELS[step.step]}
                </span>
                <span className="font-mono text-white/35 text-xs">
                  {step.step}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-3 text-xs">
              <span className="text-white/50">{STATE_COPY[step.state]}</span>
              {step.at ? (
                <TimeAgo at={step.at} now={now} className="text-white/40" />
              ) : null}
            </span>
          </div>
        </div>
      ))}
    </Card>
  );
}
