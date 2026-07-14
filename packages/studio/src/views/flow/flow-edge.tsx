import type { Edge, EdgeProps } from "@xyflow/react";

/**
 * The "railway" edge — the control room's whole visual language.
 *
 * There is NO crisp line: the track is a single wide, blurred, low-opacity
 * stroke (a glow), and the only sharp thing on it is a handful of small
 * particles riding the path via CSS Motion Path (`offset-path`). Traffic reads
 * as light moving down a rail rather than as a labelled arrow.
 *
 * Two rules keep it honest:
 * - The glow is a CSS `filter: blur()`, NOT an SVG `<filter>`. SVG filter
 *   regions are bbox-relative, and a perfectly straight segment (aligned
 *   rows produce them constantly) has a zero-area bbox — the region
 *   collapses and the whole edge vanishes. CSS blur has no user-defined
 *   region, so straight rails glow like every other rail.
 * - Particle delays come from a deterministic hash of the edge id, never
 *   `Math.random()`. A re-render must produce byte-identical inline styles or
 *   the browser restarts every animation (and the map visibly stutters on
 *   each poll).
 */

export type FlowEdgeData = {
  /** Rounded path from `tier-layout` — drawn AND used as the offset-path. */
  d: string;
  /** Polyline length; paces the particles at a constant speed. */
  length: number;
  transitions: number;
  contacts: number;
};

export type FlowRfEdge = Edge<FlowEdgeData, "flow">;

/** Track width by traffic — log-bucketed so one loud edge can't dwarf the map. */
const WIDTH_BUCKETS = [4, 6, 9, 12, 16];
/** Particle count by traffic — same bucketing, capped so it stays readable. */
const PARTICLE_BUCKETS = [2, 3, 4, 5, 7];

/** Pixels per second a particle travels. */
const PARTICLE_SPEED = 90;

function bucketIndex(transitions: number): number {
  if (transitions <= 0) return 0;
  const index = Math.floor(Math.log10(transitions));
  return Math.min(WIDTH_BUCKETS.length - 1, Math.max(0, index));
}

export function strokeWidthFor(transitions: number): number {
  return WIDTH_BUCKETS[bucketIndex(transitions)] as number;
}

export function particleCountFor(transitions: number): number {
  return PARTICLE_BUCKETS[bucketIndex(transitions)] as number;
}

/** FNV-1a → [0, 1). Deterministic: same edge + index ⇒ same phase, forever. */
function seeded(key: string, index: number): number {
  let hash = 0x811c9dc5;
  const input = `${key}#${index}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

export function FlowEdge({ id, data }: EdgeProps<FlowRfEdge>) {
  if (!data) return null;
  const { d, length, transitions } = data;
  const width = strokeWidthFor(transitions);
  const count = particleCountFor(transitions);
  const duration = Math.max(1.5, length / PARTICLE_SPEED);

  return (
    <>
      <g style={{ filter: "blur(6px)" }}>
        <path
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={width}
          strokeLinecap="round"
          opacity={0.5}
        />
      </g>
      {Array.from({ length: count }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the particle's identity (and its phase seed)
          key={i}
          r={1.6}
          fill="rgba(255,255,255,0.9)"
          className="flow-particle"
          style={{
            offsetPath: `path("${d}")`,
            animationDuration: `${duration}s`,
            // Negative delay = start mid-flight, so the rail is populated on
            // first paint instead of dribbling particles out of the source.
            animationDelay: `-${(seeded(id, i) * duration).toFixed(3)}s`,
          }}
        />
      ))}
    </>
  );
}
