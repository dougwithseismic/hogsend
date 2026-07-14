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
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FlowCanvas } from "./flow/flow-canvas";
import { laneColor } from "./flow/lane-colors";

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

/** Human label for a lane chip. */
function laneLabel(id: string): string {
  if (id === "organic") return "Organic";
  if (id === "__other") return "Other";
  return id;
}

export function FlowView() {
  const [windowDays, setWindowDays] = useState(7);
  const [selectedLane, setSelectedLane] = useState<string | null>(null);

  const query = useQuery({
    queryKey: qk.flow(windowDays),
    // Always colour by campaign — the chip row lets the operator focus a lane.
    queryFn: () => getFlow({ windowDays, laneBy: "utm_campaign" }),
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });

  const data = query.data;
  // Only honour a selection that still exists in the current window — a lane
  // that ages out clears itself rather than dimming the whole map with no chip
  // left to toggle. Explicit null check: a falsy-but-real lane id must not
  // silently deselect.
  const activeLane =
    selectedLane !== null &&
    (data?.lanes.some((l) => l.id === selectedLane) ?? false)
      ? selectedLane
      : null;
  // The chip row is only meaningful once there's a REAL campaign to focus —
  // `organic`/`__other` alone (a fresh install pre-campaigns) shows nothing.
  const chipLanes = data?.lanes.filter((l) => l.id !== "__other") ?? [];
  const hasRealLane =
    data?.lanes.some((l) => l.id !== "organic" && l.id !== "__other") ?? false;

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

      {/* Acquisition-lane chips — hidden entirely until there's a real campaign
          to focus (organic-only = nothing to pick). `__other` is never a chip:
          its per-edge meaning differs from the summary's, so selecting it is
          incoherent. Click a lane to focus it, click again to return to the
          neutral resting map. */}
      {hasRealLane ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="eyebrow mr-1 text-[11px] text-white/40">
            Acquisition lane
          </span>
          {chipLanes.map((lane) => {
            const active = selectedLane === lane.id;
            return (
              <button
                key={lane.id}
                type="button"
                onClick={() => setSelectedLane(active ? null : lane.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  active
                    ? "border-white/40 bg-white/[0.06] text-white/90"
                    : "border-hairline-faint text-white/55 hover:border-white/20",
                )}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: laneColor(lane.id) }}
                />
                <span className="font-medium">{laneLabel(lane.id)}</span>
                <span className="font-mono text-white/40">
                  {formatNumber(lane.count)}
                </span>
              </button>
            );
          })}
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
        <FlowCanvas data={data} selectedLane={activeLane} />
      )}
    </div>
  );
}
