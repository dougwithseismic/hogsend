import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
} from "@xyflow/react";
import { memo } from "react";

/**
 * Custom ReactFlow edge for the journey Flow tab. Carries the graph edge's
 * semantic `kind` as color (yes/no/fired/timeout), renders the label as a
 * small chip via EdgeLabelRenderer, and — when the source node has users
 * parked on it — animates a dot along the path (an `animateMotion` SVG child,
 * which is GPU-cheap, unlike ReactFlow's `animated: true` dash cadence).
 */

export interface FlowEdgeData extends Record<string, unknown> {
  kind?: "main" | "yes" | "no" | "fired" | "timeout";
  label?: string;
  /** True when the edge's source node currently holds live users. */
  live?: boolean;
  /**
   * Dagre's routed waypoints (flow-space) for this edge. When present, the
   * edge follows them (bending around intermediate nodes) instead of a
   * straight source→target line. Endpoints come from the real handles.
   */
  points?: Array<{ x: number; y: number }>;
}

/**
 * Build a rounded-corner SVG path through a list of points. Each interior
 * point becomes a small arc so routed edges read as smooth wire, not a jagged
 * polyline. Falls back to a straight segment for < 3 points.
 */
type Pt = { x: number; y: number };
function roundedPath(pts: Pt[]): string {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return "";
  if (pts.length < 3) return `M ${first.x},${first.y} L ${last.x},${last.y}`;
  const r = 8;
  const shorten = (from: Pt, to: Pt): Pt => {
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = Math.min(r, len / 2);
    return { x: to.x + (dx / len) * d, y: to.y + (dy / len) * d };
  };
  let d = `M ${first.x},${first.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    if (!prev || !cur || !next) continue;
    const a = shorten(prev, cur);
    const b = shorten(next, cur);
    d += ` L ${a.x},${a.y} Q ${cur.x},${cur.y} ${b.x},${b.y}`;
  }
  d += ` L ${last.x},${last.y}`;
  return d;
}

const EDGE_COLORS: Record<string, string> = {
  main: "rgba(255,255,255,0.35)",
  yes: "#34d399",
  no: "#f87171",
  fired: "#f64838",
  timeout: "#fbbf24",
};

export const JourneyFlowEdge = memo(function JourneyFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const { kind, label, live, points } = (data ?? {}) as FlowEdgeData;
  const color = EDGE_COLORS[kind ?? "main"] ?? EDGE_COLORS.main;

  // Prefer dagre's routed waypoints (bent around intermediate nodes). Anchor
  // the ends to the real handle positions, interior bends come from dagre.
  let path: string;
  let labelX: number;
  let labelY: number;
  const interior = points?.slice(1, -1) ?? [];
  if (interior.length > 0) {
    const chain = [
      { x: sourceX, y: sourceY },
      ...interior,
      { x: targetX, y: targetY },
    ];
    path = roundedPath(chain);
    const mid = chain[Math.floor(chain.length / 2)] ?? {
      x: sourceX,
      y: sourceY,
    };
    labelX = mid.x;
    labelY = mid.y;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 8,
    });
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: color, strokeWidth: 1.5 }}
      />
      {live ? (
        <circle r="2.5" fill="#f64838" opacity="0.9">
          <animateMotion dur="3s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded-full border border-hairline-faint bg-[#0a0606] px-1.5 py-0.5 text-[10px] leading-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

export const FLOW_EDGE_TYPES = {
  journeyEdge: JourneyFlowEdge,
} as const;
