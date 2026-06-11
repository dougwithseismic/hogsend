import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  GitBranch,
  MailCheck,
  MailWarning,
  Send,
  UserMinus,
  Users,
  Zap,
} from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { CardsSkeleton, ErrorState, PageHeader } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DocLink } from "@/components/ui/doc-link";
import { getOverview, type OverviewMetrics, qk } from "@/lib/admin-api";
import { formatNumber, formatPercent } from "@/lib/format";
import { links } from "@/lib/links";
import { cn } from "@/lib/utils";

/** Brand-new install: nothing has happened yet across the board. */
function isFreshInstall(m: OverviewMetrics): boolean {
  return (
    m.totalContacts === 0 && m.activeJourneys === 0 && m.emailsSent30d === 0
  );
}

function OnboardingCard() {
  return (
    <Card className="border-accent/40 bg-accent-tint hover:border-accent/40">
      <CardHeader>
        <CardTitle className="text-base">Welcome to Hogsend Studio</CardTitle>
        <CardDescription>
          Studio observes your code-first lifecycle engine. Here's the path to
          your first running journey.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-1.5 text-sm text-white/60">
          <li>
            <span className="font-medium text-white">1.</span> Define a journey
            in code and start the worker.
          </li>
          <li>
            <span className="font-medium text-white">2.</span> Fire its trigger
            event to enrol a test user.
          </li>
          <li>
            <span className="font-medium text-white">3.</span> Watch enrolments,
            sends, and exits land here.
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Link to="/debug" className={cn(buttonVariants({ size: "sm" }))}>
            <Zap className="h-4 w-4" />
            Send a test event
          </Link>
          <DocLink href={links.quickstart}>Quickstart</DocLink>
          <DocLink href={links.journeys} variant="ghost">
            Create a journey
          </DocLink>
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewView() {
  const query = useQuery({ queryKey: qk.overview, queryFn: getOverview });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Key delivery and engagement metrics at a glance."
      />

      {query.isPending ? (
        <CardsSkeleton count={6} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <>
          {isFreshInstall(query.data) ? <OnboardingCard /> : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Total contacts"
              value={formatNumber(query.data.totalContacts)}
              icon={Users}
            />
            <StatCard
              label="Active journeys"
              value={formatNumber(query.data.activeJourneys)}
              hint="Instances active or waiting"
              icon={GitBranch}
            />
            <StatCard
              label="Sent (24h)"
              value={formatNumber(query.data.emailsSent24h)}
              icon={Send}
            />
            <StatCard
              label="Sent (7d)"
              value={formatNumber(query.data.emailsSent7d)}
              icon={MailCheck}
            />
            <StatCard
              label="Sent (30d)"
              value={formatNumber(query.data.emailsSent30d)}
              icon={MailCheck}
            />
            <StatCard
              label="Bounce rate (30d)"
              value={formatPercent(query.data.bounceRate30d)}
              hint="Bounced / sent in last 30 days"
              icon={MailWarning}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
              label="Unsubscribe rate"
              value={formatPercent(query.data.unsubscribeRate)}
              hint="Unsubscribed / total preferences"
              icon={UserMinus}
            />
          </div>
        </>
      )}
    </div>
  );
}
