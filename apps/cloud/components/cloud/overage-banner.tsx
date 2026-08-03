import { TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import { formatCount } from "@/components/cloud/usage-meter";
import { PLAN_CATALOG } from "@/src/lib/plan-catalog";
import type { UsageView } from "@/src/services/usage";

/**
 * The overage state, wherever a tenant is looking (overview and Usage).
 *
 * It renders NOTHING when nothing is over — a permanent "you are within your
 * limits" strip is noise, and noise is what makes a real banner invisible.
 *
 * Two states, and the difference between them is real rather than cosmetic:
 *  - **paused** — enforcement has already set `HOGSEND_INGEST_SUSPENDED` on the
 *    organization's stacks, so `/v1/events` is answering 429 right now;
 *  - **over** — the meter is past the cap but the sweep has not run since. The
 *    copy says what WILL happen rather than pretending it already has.
 *
 * The numbers are the whole organization's, across every environment, because
 * that is what the cap is measured against (`metering/enforcement.ts`).
 *
 * Every line is a fact: what was used, what the plan allows, what stops, what
 * does not stop, and the two things that lift it.
 */

type OverageBannerProps = {
  view: UsageView;
  /** Link to the Usage page. Omitted on Usage itself. */
  href?: string;
};

export function OverageBanner({
  view,
  href,
}: OverageBannerProps): JSX.Element | null {
  const breached: string[] = [];
  if (view.overEvents) {
    breached.push(
      `${formatCount(view.totalEvents)} events against a ${formatCount(
        view.limits.eventsPerMonth,
      )} limit`,
    );
  }
  if (view.overEmails) {
    breached.push(
      `${formatCount(view.totalEmails)} emails against a ${formatCount(
        view.limits.emailsPerMonth,
      )} limit`,
    );
  }

  if (breached.length === 0 && !view.ingestSuspended) return null;

  const plan = PLAN_CATALOG[view.plan].label;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-caution/40 bg-caution-tint p-4 text-white sm:flex-row sm:items-start sm:gap-3">
      <TriangleAlert
        aria-hidden
        className="size-4 shrink-0 text-caution sm:mt-0.5"
        strokeWidth={1.75}
      />
      <div className="flex flex-col gap-1">
        <p className="font-medium text-sm tracking-[-0.02em]">
          {view.ingestSuspended
            ? "Ingest is paused on this organization's stacks"
            : "Usage is over the plan limit"}
        </p>
        <p className="text-sm text-white/70 leading-6">
          {breached.length > 0
            ? `${periodLabel(view)} on the ${plan} plan, across every environment: ${breached.join(" and ")}. `
            : `${periodLabel(view)} usage is over the ${plan} plan's limits. `}
          {view.ingestSuspended
            ? "POST /v1/events returns 429 on this organization's stacks. Events already accepted are kept, and email, journeys and the dashboard are unaffected. "
            : "The nightly sweep pauses ingest on this organization's stacks. Events already accepted are kept. "}
          {liftLine(view.plan)}
        </p>
        {href ? (
          <a
            href={href}
            className="text-sm text-white underline underline-offset-4 transition-colors hover:text-white/70"
          >
            View usage
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** "This month" for a paid plan; a trial is billed over its whole 14 days. */
function periodLabel(view: UsageView): string {
  return view.plan === "trial" ? "This trial" : "This month";
}

/** What actually lifts the pause — and it is not the same for both. */
function liftLine(plan: UsageView["plan"]): string {
  return plan === "trial"
    ? "A trial's cap is a total for the whole 14 days, so it does not reset on the 1st: buying a plan lifts the pause as soon as the checkout lands."
    : "Upgrading lifts the pause as soon as the checkout lands; otherwise the counter resets at the start of the next UTC month.";
}
