import { Check, Circle } from "lucide-react";
import type { JSX } from "react";
import { Card } from "@/components/ds/card";
import { cn } from "@/lib/cn";
import type { OnboardingView } from "@/src/lib/onboarding";
import { CopyValue } from "./copy-value";
import { OnboardingRefresh } from "./onboarding-refresh";

/**
 * What a new customer still has to do, and nothing else.
 *
 * Renders only while something is outstanding: a checklist that stays on the
 * page once every box is ticked is decoration, and this page is meant to get
 * shorter as an instance matures.
 *
 * Every tick is answered from the control plane's own tables (see
 * `readOnboarding`), so a step is ticked because it actually happened — never
 * because we assumed it had.
 */
export function OnboardingChecklist({
  view,
}: {
  view: OnboardingView;
}): JSX.Element | null {
  if (view.complete) return null;

  const done = view.steps.filter((step) => step.done).length;

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-medium text-white tracking-[-0.02em]">
          Get set up
        </h2>
        <span className="font-mono text-white/40 text-xs">
          {done}/{view.steps.length}
        </span>
      </div>

      <ol className="flex flex-col gap-4">
        {view.steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border",
                step.done
                  ? "border-good/40 bg-good/15 text-good"
                  : "border-white/15 text-white/25",
              )}
            >
              {step.done ? (
                <Check aria-hidden className="size-3" strokeWidth={2.5} />
              ) : (
                <Circle aria-hidden className="size-2" strokeWidth={3} />
              )}
            </span>

            <span className="flex min-w-0 flex-col gap-1.5">
              <span
                className={cn(
                  "text-sm tracking-[-0.01em]",
                  step.done ? "text-white/50 line-through" : "text-white",
                )}
              >
                {step.title}
              </span>

              {/* The how disappears once it is done — nobody needs it then. */}
              {!step.done && step.hint ? (
                <span className="max-w-prose text-white/50 text-xs leading-5">
                  {step.hint}
                  {/*
                    Say the lag out loud. These two are counted by the nightly
                    metering sweep, so someone who sends their first email at
                    10am would otherwise sit watching an unticked box until
                    03:00 the next morning and conclude it was broken.
                  */}
                  {step.freshness === "daily" ? (
                    <span className="text-white/35"> Counted daily.</span>
                  ) : null}
                </span>
              ) : null}

              {!step.done && step.command ? (
                <span className="mt-0.5 inline-flex w-fit items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] py-1.5 pr-1.5 pl-3">
                  <code className="font-mono text-white/80 text-xs">
                    {step.command}
                  </code>
                  <CopyValue
                    value={step.command}
                    label={step.title}
                    buttonOnly
                  />
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      {/*
        Only while a refresh could actually reveal something. Once the live
        steps are done, what is left cannot move until the nightly sweep.
      */}
      {view.worthRefreshing ? <OnboardingRefresh /> : null}
    </Card>
  );
}
