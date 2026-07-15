import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Radar, Radio } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  TableSkeleton,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { getFlow, qk } from "@/lib/admin-api";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FlowCanvas } from "./flow/flow-canvas";
import { laneColor } from "./flow/lane-colors";
import { flowEdgeId, visibleFlow } from "./flow/map-layout";
import { NodePanel } from "./flow/node-panel";
import { particleBus } from "./flow/particle-bus";
import {
  type FlowTransitionMessage,
  useFlowStream,
} from "./flow/use-flow-stream";

/**
 * The control room — how contacts actually move through the product, drawn
 * from the event history (`GET /v1/admin/flow`).
 *
 * Nodes are the real machine: every journey, every funnel stage, the money.
 * Each card carries its own heat (conversion + revenue) and its pile-up ("N
 * stuck"); traffic between them is the glow + particle density on each rail.
 * The engine picks the classifier, the attribution model and the dwell
 * threshold — this view sends only the window, so the map an operator sees is
 * the map the engine considers canonical.
 *
 * P4 — the LIVE layer: a "Live" toggle (default on) subscribes to
 * `GET /v1/admin/flow/stream`. Each real transition rides its matching rail as
 * a bright pulse (via `particle-bus`, so React Flow's store is never touched)
 * and tightens the poll cadence; an unknown edge (a map gone stale vs a deploy)
 * triggers a bounded refetch. The stream degrades to polling on its own.
 */

/**
 * Poll cadence: brisk while live, calm when off. Live is 10s, not 5s: the
 * SSE pulses carry the immediacy, the poll is only the truth layer — and the
 * engine's poll-collapsing memo has a 5s TTL, so a 5s poll would recompute
 * the full windowed aggregate on EVERY tick.
 */
const LIVE_POLL_INTERVAL_MS = 10_000;
const IDLE_POLL_INTERVAL_MS = 30_000;
/** Distinct unknown edges before we assume the loaded map is stale. */
const STALE_EDGE_THRESHOLD = 3;
/** At most one stale-map refetch this often. */
const STALE_REFETCH_COOLDOWN_MS = 10_000;

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.flow(windowDays),
    // Always colour by campaign — the chip row lets the operator focus a lane.
    queryFn: () => getFlow({ windowDays, laneBy: "utm_campaign" }),
    refetchInterval: live ? LIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });

  const data = query.data;

  // The edge ids currently drawn — kept in a ref so the stream callback reads
  // the freshest map without re-subscribing the EventSource on every poll.
  const knownEdgesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    knownEdgesRef.current = new Set(
      (data?.edges ?? []).map((e) => flowEdgeId(e)),
    );
  }, [data]);
  // Distinct unknown edges seen since the last refetch, and when we last fired
  // one — so a stale map self-heals without a refetch storm. Edges that were
  // STILL unknown after a refetch are remembered as never-known (a live
  // from-node can predate the selected window — the aggregate will never draw
  // that edge) so they can't drive a perpetual invalidate cycle.
  const unknownEdgesRef = useRef<Set<string>>(new Set());
  const neverKnownEdgesRef = useRef<Set<string>>(new Set());
  const lastStaleRefetchRef = useRef(0);

  const changeWindow = (days: number) => {
    setWindowDays(days);
    // A new window is a new truth — forget the never-known verdicts.
    neverKnownEdgesRef.current.clear();
    unknownEdgesRef.current.clear();
  };

  const handleTransition = useCallback(
    (t: FlowTransitionMessage) => {
      // A cold-cache transition (from null) has no rail to ride; the aggregate
      // poll will surface the node. Only edge transitions animate.
      if (t.from === null) return;
      const edgeId = `${t.from}->${t.to}`;
      if (knownEdgesRef.current.has(edgeId)) {
        particleBus.publish(edgeId, { lane: t.lane });
        return;
      }
      if (neverKnownEdgesRef.current.has(edgeId)) return;
      // Unknown edge: the drawn map predates this path. Refetch once we've seen
      // a few DISTINCT unknown edges (one-off is likely a race with the poll),
      // rate-limited so a burst can't hammer the API.
      unknownEdgesRef.current.add(edgeId);
      if (unknownEdgesRef.current.size < STALE_EDGE_THRESHOLD) return;
      const now = Date.now();
      if (now - lastStaleRefetchRef.current < STALE_REFETCH_COOLDOWN_MS) return;
      lastStaleRefetchRef.current = now;
      // Whatever is still unknown when we ASK again is, if it stays unknown,
      // never-known: move the batch over so the same ids can't re-trigger.
      for (const id of unknownEdgesRef.current) {
        neverKnownEdgesRef.current.add(id);
      }
      unknownEdgesRef.current.clear();
      // Partial-key match invalidates every window's flow query.
      queryClient.invalidateQueries({ queryKey: ["flow"] });
    },
    [queryClient],
  );

  const { status: streamStatus } = useFlowStream({
    enabled: live,
    onTransition: handleTransition,
  });
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

  // Resolve the selected node against the CURRENT map — a node that ages out of
  // the window closes its panel rather than stranding it on stale data.
  const selectedNode =
    selectedNodeId !== null
      ? (data?.nodes.find((n) => n.id === selectedNodeId) ?? null)
      : null;

  // The earn-your-canvas rule (map-layout): only nodes with traffic, a live
  // enrollment, a pile-up, or an edge are drawn — the registry's empty
  // remainder sits behind the toggle. This is what turns "40 registered
  // cards" into "the marketing engine".
  const visible = data ? visibleFlow(data, showAll) : null;
  const canvasData =
    data && visible
      ? { ...data, nodes: visible.nodes, edges: visible.edges }
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Control room"
        description="Every place your contacts touch, and how they move between them."
        action={
          <div className="flex items-end gap-2">
            {live && streamStatus === "unavailable" ? (
              <span className="mb-1.5 rounded-full border border-hairline-faint px-2.5 py-1 text-[11px] text-white/50">
                Live stream unavailable — polling
              </span>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="flow-window">Time range</Label>
              <Select
                id="flow-window"
                value={String(windowDays)}
                onChange={(e) => changeWindow(Number(e.target.value))}
              >
                {WINDOWS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </div>
            {visible && (visible.hiddenCount > 0 || showAll) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAll((v) => !v)}
                title="Registered nodes with no traffic, enrollments or pile-up in this window"
              >
                {showAll
                  ? "Hide empty"
                  : `Show all (${formatNumber(visible.hiddenCount)} empty)`}
              </Button>
            ) : null}
            <Button
              variant={live ? "default" : "outline"}
              size="sm"
              onClick={() => setLive((v) => !v)}
              title="Stream contact movement live"
            >
              <Radio className="h-4 w-4" />
              {live ? "Live" : "Go live"}
            </Button>
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
        // The fixed height MUST live on this wrapper, not on PanelGroup —
        // react-resizable-panels forces an inline `height: 100%` on the group,
        // which overrides any height class on it (see journey-flow).
        <div className="h-[720px] overflow-hidden">
          <PanelGroup direction="horizontal" className="h-full">
            {/* The canvas Panel is ALWAYS mounted (id/order stable) so adding
                the drill-down Panel never remounts it — the row order, viewport
                and every particle animation live inside it. */}
            <Panel id="flow-canvas" order={1} minSize={45}>
              <FlowCanvas
                data={canvasData ?? data}
                selectedLane={activeLane}
                onNodeSelect={setSelectedNodeId}
                onPaneSelect={() => setSelectedNodeId(null)}
              />
            </Panel>
            {selectedNode ? (
              <>
                <PanelResizeHandle className="group relative flex w-2 items-center justify-center outline-none">
                  <div className="h-full w-px bg-hairline-faint transition-colors group-hover:bg-accent/40 group-data-[resize-handle-state=drag]:bg-accent" />
                </PanelResizeHandle>
                <Panel
                  id="flow-node"
                  order={2}
                  defaultSize={32}
                  minSize={22}
                  collapsible
                  onCollapse={() => setSelectedNodeId(null)}
                >
                  <aside className="h-full overflow-hidden rounded-md border border-hairline-faint bg-white/[0.015]">
                    {/* Keyed by node id so switching nodes resets the panel's
                        "Stuck only" default cleanly. */}
                    <NodePanel
                      key={selectedNode.id}
                      node={selectedNode}
                      windowDays={windowDays}
                      onClose={() => setSelectedNodeId(null)}
                    />
                  </aside>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
        </div>
      )}
    </div>
  );
}
