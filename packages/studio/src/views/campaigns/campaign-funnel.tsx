import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { FunnelNotes, FunnelStages } from "@/components/funnel";
import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { type Campaign, getCampaignStats, qk } from "@/lib/admin-api";

/** Same terminal accents as the journey funnel / flow rails. */
const NOTE_COLORS = {
  skipped: "#6e7681",
  failed: "#da3633",
  bounced: "#da3633",
  complained: "#da3633",
} as const;

/**
 * The campaign's delivery funnel — recipients → sent → delivered → opened →
 * clicked, computed from the campaign row's dispatch counters plus the
 * engagement aggregate over its email sends. Mirrors the journey funnel's
 * stage-card geometry.
 */
export function CampaignFunnel({ campaign }: { campaign: Campaign }) {
  const stats = useQuery({
    queryKey: qk.campaignStats(campaign.id),
    queryFn: () => getCampaignStats(campaign.id),
  });

  if (stats.isPending) return <Skeleton className="h-28 w-full" />;
  if (stats.isError) {
    return <ErrorState error={stats.error} onRetry={() => stats.refetch()} />;
  }

  const s = stats.data;

  if (campaign.totalRecipients === 0 && s.sends === 0) {
    return (
      <EmptyState
        icon={Filter}
        title="No recipients yet"
        description={
          campaign.status === "scheduled"
            ? "The audience is resolved when the scheduled send fires."
            : "Once the blast dispatches, its delivery funnel appears here."
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <FunnelStages
        ariaLabel="Delivery funnel"
        stages={[
          {
            key: "recipients",
            label: "Recipients",
            value: campaign.totalRecipients,
          },
          { key: "sent", label: "Sent", value: campaign.sentCount },
          { key: "delivered", label: "Delivered", value: s.delivered },
          { key: "opened", label: "Opened", value: s.opened },
          { key: "clicked", label: "Clicked", value: s.clicked },
        ]}
      />
      <FunnelNotes
        label="Didn't land"
        items={[
          {
            key: "skipped",
            label: "Skipped",
            value: campaign.skippedCount,
            color: NOTE_COLORS.skipped,
          },
          {
            key: "failed",
            label: "Failed",
            value: campaign.failedCount,
            color: NOTE_COLORS.failed,
          },
          {
            key: "bounced",
            label: "Bounced",
            value: s.bounced,
            color: NOTE_COLORS.bounced,
          },
          {
            key: "complained",
            label: "Complained",
            value: s.complained,
            color: NOTE_COLORS.complained,
          },
        ]}
      />
    </div>
  );
}
