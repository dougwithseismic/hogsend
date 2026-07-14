import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getFlow, qk } from "@/lib/admin-api";
import { FlowCanvas } from "./flow/flow-canvas";

/**
 * The control room — how contacts actually move through the product, drawn
 * from the event history (`GET /v1/admin/flow`).
 *
 * Nodes are the real machine: every journey, every funnel stage, the money.
 * Each card carries its own heat (conversion + revenue) and its pile-up ("N
 * stuck"); traffic between them is the glow + particle density on each rail.
 * The engine picks the classifier, the attribution model and the dwell
 * threshold — this view sends only the window, so the map an operator sees is
 * the map the engine considers canonical. (A live stream layer lands in P4
 * against this same response shape.)
 */

const POLL_INTERVAL_MS = 30_000;

const WINDOWS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

export function FlowView() {
  const [windowDays, setWindowDays] = useState(7);

  const query = useQuery({
    queryKey: qk.flow(windowDays),
    queryFn: () => getFlow({ windowDays }),
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });

  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Control room"
        description="Every place your contacts touch, and how they move between them."
        action={
          <div className="flex items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="flow-window">Time range</Label>
              <Select
                id="flow-window"
                value={String(windowDays)}
                onChange={(e) => setWindowDays(Number(e.target.value))}
              >
                {WINDOWS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        }
      />

      {data?.meta.truncated ? (
        <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-white/70">
          That window holds too many events to project in one pass — showing the
          last {data.meta.effectiveWindowDays}{" "}
          {data.meta.effectiveWindowDays === 1 ? "day" : "days"} instead.
        </div>
      ) : null}

      {query.isError && data ? (
        <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-white/70">
          Refresh failing — showing the last successful map. Retrying in the
          background.
        </div>
      ) : null}

      {query.isPending ? (
        <TableSkeleton rows={4} />
      ) : query.isError && !data ? (
        // A failed BACKGROUND poll must never unmount the canvas: the row
        // accumulator, element identities, viewport and every particle
        // animation live inside it. Stale map + banner beats a dead screen.
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !data || data.nodes.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No events in this window yet"
          description="Once contacts start touching your product, the surfaces they hit — and the paths between them — appear here."
        />
      ) : (
        <FlowCanvas data={data} />
      )}
    </div>
  );
}
