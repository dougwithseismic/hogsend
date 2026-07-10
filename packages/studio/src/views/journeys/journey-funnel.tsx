import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { FunnelNotes, FunnelStages } from "@/components/funnel";
import { EmptyState, ErrorState } from "@/components/states";
import { Skeleton } from "@/components/ui/skeleton";
import { getJourneyFunnel, getJourneyGraph, qk } from "@/lib/admin-api";

/**
 * Terminal-state accents lifted from the flow view's NODE_STYLE so the "left
 * the journey" dots speak the same crimzon language across both views.
 */
const TERMINAL = {
  failed: "#da3633",
  exited: "#6e7681",
} as const;

export function JourneyFunnel({
  journeyId,
  hasEmail,
}: {
  journeyId: string;
  /**
   * Whether this journey has email-send stages. When omitted it's derived from
   * the journey graph (a react-query cache hit on the detail page, where
   * <JourneyFlow> already fetched `qk.journeyGraph`) OR-ed with "has it ever
   * sent?" — so a send node with zero sends still shows the (empty) email
   * stages, and a degraded/unavailable graph still expands once a send lands.
   */
  hasEmail?: boolean;
}) {
  const funnel = useQuery({
    queryKey: qk.journeyFunnel(journeyId),
    queryFn: () => getJourneyFunnel(journeyId),
  });
  // Consulted only for stage detection; never blocks render. Deduped with the
  // flow view's identical query, so it's effectively free on the detail page.
  const graph = useQuery({
    queryKey: qk.journeyGraph(journeyId),
    queryFn: () => getJourneyGraph(journeyId),
    enabled: hasEmail === undefined,
  });

  if (funnel.isPending) return <Skeleton className="h-28 w-full" />;
  if (funnel.isError) {
    return <ErrorState error={funnel.error} onRetry={() => funnel.refetch()} />;
  }

  const d = funnel.data;

  if (d.enrolled === 0) {
    return (
      <EmptyState
        icon={Filter}
        title="No enrollments yet"
        description="Once users enter this journey, their conversion funnel appears here."
      />
    );
  }

  // Structural truth: the graph has a `send` node. Ignore a degraded graph (its
  // node set is unreliable) and OR in runtime evidence so a send node with zero
  // sends still shows the email stages, while a send-less journey collapses to
  // enrolled → completed.
  const g = graph.data?.graph;
  const graphHasSend =
    g && !g.degraded ? g.nodes.some((n) => n.type === "send") : undefined;
  const showEmail = hasEmail ?? graphHasSend ?? d.emailSent > 0;

  const stages = [
    { key: "enrolled", label: "Enrolled", value: d.enrolled },
    ...(showEmail
      ? [
          { key: "sent", label: "Email sent", value: d.emailSent },
          { key: "opened", label: "Opened", value: d.emailOpened },
          { key: "clicked", label: "Clicked", value: d.emailClicked },
        ]
      : []),
    { key: "completed", label: "Completed", value: d.completed },
  ];

  return (
    <div className="space-y-3">
      <FunnelStages stages={stages} />
      <FunnelNotes
        label="Left the journey"
        items={[
          {
            key: "failed",
            label: "Failed",
            value: d.failed,
            color: TERMINAL.failed,
          },
          {
            key: "exited",
            label: "Exited",
            value: d.exited,
            color: TERMINAL.exited,
          },
        ]}
      />
    </div>
  );
}
