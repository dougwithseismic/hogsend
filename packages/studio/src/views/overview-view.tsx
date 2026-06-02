import { useQuery } from "@tanstack/react-query";
import {
  GitBranch,
  MailCheck,
  MailWarning,
  Send,
  UserMinus,
  Users,
} from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { CardsSkeleton, ErrorState, PageHeader } from "@/components/states";
import { getOverview, qk } from "@/lib/admin-api";
import { formatNumber, formatPercent } from "@/lib/format";

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
