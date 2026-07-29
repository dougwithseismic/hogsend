import { Gauge } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { OverageBanner } from "@/components/cloud/overage-banner";
import { PlanActions } from "@/components/cloud/plan-actions";
import { UsageMeter } from "@/components/cloud/usage-meter";
import { TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { Hairline } from "@/components/ds/decor";
import { EmptyState } from "@/components/ds/empty-state";
import { Section } from "@/components/ds/section";
import { PageHeader } from "@/components/shell/page-header";
import {
  billingNotice,
  CHECKOUT_COMPLETE_NOTICE,
} from "@/src/lib/billing-notice";
import { canManageMembers, readMemberContext } from "@/src/lib/org-members";
import { PLAN_CATALOG } from "@/src/lib/plan-catalog";
import { requireActiveOrganization } from "@/src/lib/session";
import { readUsageView } from "@/src/services/usage";

export const metadata: Metadata = {
  title: "Usage",
  description: "Metered usage against plan limits for the current month.",
};

/**
 * What this organization used this month, against what its plan allows.
 *
 * A server component reading `usage_counters` — the sink the nightly sweep
 * writes (`metering/sweep.ts`). There is no client fetch and no polling: the
 * numbers change once a night, so a page that re-fetched them would be
 * pretending to be live.
 *
 * The caps are shown against the ORGANIZATION's total, across every
 * environment, because that is exactly what enforcement measures
 * (`metering/enforcement.ts`) — a page that put staging outside the cap would
 * be describing a bypass that does not exist. The per-environment list below
 * says where the usage came from.
 */

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function UsagePage({ searchParams }: PageProps) {
  const { record } = await requireActiveOrganization();
  const query = await searchParams;
  const requestHeaders = await headers();
  const [view, context] = await Promise.all([
    readUsageView({ organizationId: record.id }),
    readMemberContext(requestHeaders),
  ]);

  const notice = billingNotice(query.billing);
  const completed = query.checkout === "complete";
  const plan = PLAN_CATALOG[view.plan];

  return (
    <main className="flex flex-1 flex-col">
      <PageHeader
        title="Usage"
        description={`Events ingested and emails sent by ${record.name} across ${view.months.length === 1 ? view.month : `${view.months[0]}–${view.month}`}, against the ${plan.label} plan's limits. Counters are written by the nightly metering sweep.`}
      />

      <Section divider={false} containerClassName="flex flex-col gap-4">
        {notice ? (
          <Card className="text-sm text-white/70 leading-6">{notice}</Card>
        ) : null}
        {completed ? (
          <Card className="text-sm text-white/70 leading-6">
            {CHECKOUT_COMPLETE_NOTICE}
          </Card>
        ) : null}

        <OverageBanner view={view} />

        <Card className="flex flex-col gap-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <span className="inline-flex items-center gap-2">
                <TagPill tone="accent">{plan.label}</TagPill>
                <span className="text-sm text-white/60">{plan.price}</span>
              </span>
              <p className="max-w-xl text-sm text-white/60 leading-6">
                {planClockLine(view.plan, view.trialDaysLeft, view.trialEndsAt)}
              </p>
            </div>
            <PlanActions
              plan={view.plan}
              canManage={canManageMembers(context.role)}
              billingCustomerId={view.billingCustomerId}
            />
          </div>

          <Hairline />

          <div className="flex flex-col gap-4">
            <h2 className="font-medium text-sm text-white tracking-[-0.02em]">
              {view.plan === "trial"
                ? "Every environment, this trial"
                : "Every environment, this month"}
            </h2>
            <UsageMeter
              label="Events ingested"
              used={view.totalEvents}
              limit={view.limits.eventsPerMonth}
            />
            <UsageMeter
              label="Emails sent"
              used={view.totalEmails}
              limit={view.limits.emailsPerMonth}
            />
          </div>
        </Card>

        {view.environments.length > 0 ? (
          <Card className="flex flex-col p-0">
            <h2 className="px-6 pt-6 pb-4 font-medium text-sm text-white tracking-[-0.02em]">
              Every environment
            </h2>
            {view.environments.map((environment, index) => (
              <div key={environment.environmentId}>
                {index > 0 ? <Hairline /> : null}
                <div className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
                  <div className="flex flex-col gap-1">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm text-white tracking-[-0.02em]">
                        {environment.name}
                      </span>
                      <TagPill>{environment.kind}</TagPill>
                      {environment.ingestSuspendedAt ? (
                        <TagPill tone="caution">ingest paused</TagPill>
                      ) : null}
                    </span>
                    <span className="text-white/50 text-xs">
                      {environment.stackStatus
                        ? `stack ${environment.stackStatus}`
                        : "no stack"}
                    </span>
                  </div>
                  <dl className="flex gap-8 text-sm">
                    <div className="flex flex-col gap-1">
                      <dt className="text-white/50 text-xs">Events</dt>
                      <dd className="text-white tabular-nums">
                        {environment.events.toLocaleString("en-US")}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-white/50 text-xs">Emails</dt>
                      <dd className="text-white tabular-nums">
                        {environment.emails.toLocaleString("en-US")}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            ))}
          </Card>
        ) : (
          <EmptyState
            icon={<Gauge aria-hidden className="size-5" strokeWidth={1.75} />}
            title="No environments to meter"
            description="This organization has no environments. Its production environment is created with the organization, so an empty list means one was removed."
          />
        )}
      </Section>
    </main>
  );
}

/** One sentence about the plan's clock — a trial has one, a paid plan does not. */
function planClockLine(
  plan: string,
  daysLeft: number | null,
  trialEndsAt: Date | null,
): string {
  if (plan !== "trial" || !trialEndsAt || daysLeft === null) {
    return "Limits reset at the start of each UTC calendar month.";
  }
  const date = trialEndsAt.toISOString().slice(0, 10);
  if (daysLeft === 0) {
    return `The trial ended on ${date}. Its stacks are stopped until a plan is bought; the data is kept.`;
  }
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in the trial, which ends on ${date}. Trial limits are totals for the whole trial, not a monthly allowance.`;
}
