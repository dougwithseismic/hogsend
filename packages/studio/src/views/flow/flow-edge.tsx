import type { Edge, EdgeProps } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { roundedPath, type XY } from "@/views/journeys/flow-layout";
import { laneColor } from "./lane-colors";
import { particleBus } from "./particle-bus";

/**
 * The "railway" edge — the control room's whole visual language.
 *
 * The track is LIGHT, not a line: three layered strokes — a wide soft halo,
 * a tighter bright core, and a faint hairline — inside one `screen`-blended
 * group, so rails crossing each other ADD light at the intersection instead
 * of flattening to grey. The only sharp things riding it are small glowing
 * particles on the path via CSS Motion Path (`offset-path`). Traffic reads
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
 *
 * P4 — LIVE pulses: a fresh transition from the SSE stream spawns ONE bright,
 * single-shot particle (a `flow-pulse`) that rides source→target once and
 * removes itself. These are LOCAL component state fed by `particle-bus`, NEVER
 * part of `edge.data` — so a live event re-renders exactly this one edge and
 * can't disturb the reconcile identity every ambient animation depends on.
 */

export type FlowEdgeData = {
  /**
   * dagre's node-avoiding interior waypoints (layout epoch). The drawable
   * path is built PER RENDER from React Flow's live handle coordinates plus
   * these — so the rail follows a node while it is being dragged, and a poll
   * that moves nothing produces a byte-identical path.
   */
  waypoints?: XY[];
  transitions: number;
  contacts: number;
  /**
   * The value that drives the width/particle buckets: the selected lane's
   * transition count when a lane is picked, else total `transitions` (P3).
   */
  weight: number;
  /**
   * The OPPOSITE direction of a bidirectional rail (docs ⇄ course), or null
   * for a one-way edge. One shared path, dots riding both ways — the Railway
   * trick — instead of a parallel rail plus a return loop.
   */
  reverseTransitions: number | null;
  reverseWeight: number | null;
  /**
   * Lane colour when a lane is selected (glow + particles take it); `null` =
   * no lane selected, the calm neutral-white resting map.
   */
  color: string | null;
};

/** Consecutive near-duplicate points produce NaN corners — drop them. */
function dedupe(points: XY[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) {
      continue;
    }
    out.push(p);
  }
  return out;
}

function polylineLength(points: XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

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

/** Neutral white — the resting rail, and a dimmed off-lane rail. */
const NEUTRAL_STROKE = "rgba(255,255,255,0.45)";
const NEUTRAL_PARTICLE = "rgba(255,255,255,0.9)";

/** Bright white for a live pulse whose lane isn't the focused one. */
const PULSE_WHITE = "rgba(255,255,255,0.98)";

/** Most concurrent live pulses on one rail; overflow becomes a surge instead. */
const MAX_PULSES = 6;
/** How long a surge (pulse overflow) keeps the rail hot. */
const SURGE_MS = 30_000;
/** Ambient particle ceiling (top bucket) — a surge respects it. */
const MAX_PARTICLES = PARTICLE_BUCKETS[PARTICLE_BUCKETS.length - 1] as number;

/** True when the viewer asked for reduced motion — no pulses then. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface LivePulse {
  key: number;
  lane: string | null;
  /** Ride the rail target→source (the return direction of a bidirectional rail). */
  reverse: boolean;
  /** Money rides gold, slightly larger — a sale should LOOK like a sale. */
  money: boolean;
}

/** Gold for money pulses — distinct from every lane colour and the alert red. */
const MONEY_GOLD = "#f0b429";

export function FlowEdge({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<FlowRfEdge>) {
  // Live pulses (P4) — transient, LOCAL to this edge. A surge flag stands in for
  // pulses when the concurrent cap is hit, so a stampede never floods the SVG.
  const [pulses, setPulses] = useState<LivePulse[]>([]);
  const [surge, setSurge] = useState(false);
  const pulseKeyRef = useRef(0);
  const surgeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const unsubscribe = particleBus.subscribe(id, (payload) => {
      setPulses((prev) => {
        if (prev.length >= MAX_PULSES) {
          // Cap hit — flip to a surge instead of piling on more circles.
          setSurge(true);
          if (surgeTimerRef.current) clearTimeout(surgeTimerRef.current);
          surgeTimerRef.current = setTimeout(() => setSurge(false), SURGE_MS);
          return prev;
        }
        pulseKeyRef.current += 1;
        return [
          ...prev,
          {
            key: pulseKeyRef.current,
            lane: payload.lane,
            reverse: payload.reverse,
            money: payload.value !== null && payload.value > 0,
          },
        ];
      });
    });
    return () => {
      unsubscribe();
      if (surgeTimerRef.current) clearTimeout(surgeTimerRef.current);
    };
  }, [id]);

  if (!data) return null;
  const { waypoints, weight, color } = data;
  // The drawable path: live handle coordinates at the ends (so the rail
  // follows a dragged node), dagre's node-avoiding waypoints in between.
  // Everything here is a pure function of stable inputs, so an idle poll
  // re-produces a byte-identical `d` and no animation restarts.
  //
  // NODE-FIRST: the interior waypoints are only valid for the positions dagre
  // laid out. The moment either endpoint drifts (a dragged card, a dragged
  // tier box), the frozen elbows would kink through space that no longer has
  // nodes in it — so the rail drops them and runs handle-to-handle direct.
  const first = waypoints?.[0];
  const last = waypoints?.[waypoints.length - 1];
  const anchored =
    first !== undefined &&
    last !== undefined &&
    Math.hypot(first.x - sourceX, first.y - sourceY) < 40 &&
    Math.hypot(last.x - targetX, last.y - targetY) < 40;
  const interior =
    anchored && waypoints && waypoints.length > 2 ? waypoints.slice(1, -1) : [];
  const pts = dedupe([
    { x: sourceX, y: sourceY },
    ...interior,
    { x: targetX, y: targetY },
  ]);
  const d = roundedPath(pts, 12);
  const length = polylineLength(pts);
  const { reverseWeight } = data;
  // A bidirectional rail carries BOTH directions' traffic: the glow width is
  // the combined volume, and each direction gets its own dot stream.
  const combined = weight + (reverseWeight ?? 0);
  // A lane is selected (color set) but this edge carries none of it (in
  // EITHER direction): dim the rail and kill its particles, but STAY
  // MOUNTED — unmounting restarts every animation on the map.
  const dimmed = color !== null && combined === 0;
  const width = strokeWidthFor(combined);
  const baseCount = dimmed || weight <= 0 ? 0 : particleCountFor(weight);
  const reverseCount =
    dimmed || reverseWeight === null || reverseWeight <= 0
      ? 0
      : particleCountFor(reverseWeight);
  // Surge adds two ambient dots (capped at the top bucket) and brightens the
  // glow — a visible "this rail is hot right now" without more pulses.
  const count =
    surge && !dimmed ? Math.min(MAX_PARTICLES, baseCount + 2) : baseCount;
  const glowOpacity = dimmed ? 0.12 : surge ? 0.7 : 0.5;
  const duration = Math.max(1.5, length / PARTICLE_SPEED);
  // A pulse is the "express" — twice ambient speed, so a real event visibly
  // shoots ahead of the resting traffic.
  const pulseDuration = Math.max(0.75, length / (PARTICLE_SPEED * 2));
  const stroke = dimmed ? NEUTRAL_STROKE : (color ?? NEUTRAL_STROKE);
  const particleFill = color ?? NEUTRAL_PARTICLE;

  // A pulse takes the focused lane's colour only when its OWN lane is that lane
  // (proxied by colour equality — the palette is deterministic per lane id);
  // otherwise it's bright white. The wire encodes an un-attributed contact as
  // lane:null while the aggregate names that bucket "organic" — fold null to
  // organic so pulses light up when the Organic chip is focused.
  const pulseFill = (lane: string | null): string =>
    color !== null && laneColor(lane ?? "organic") === color
      ? color
      : PULSE_WHITE;

  return (
    // `screen` blends the whole rail additively with whatever is beneath it —
    // two rails crossing brighten each other the way beams of light do.
    <g style={{ mixBlendMode: "screen" }}>
      <g style={{ filter: "blur(12px)" }}>
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={width * 1.8}
          strokeLinecap="round"
          opacity={glowOpacity * 0.5}
        />
      </g>
      <g style={{ filter: "blur(2.5px)" }}>
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={Math.max(1.75, width * 0.45)}
          strokeLinecap="round"
          opacity={glowOpacity}
        />
      </g>
      {/* The hairline: barely-there, but it resolves the rail's exact course
          where the glow alone would read as fog. */}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={1}
        strokeLinecap="round"
        opacity={dimmed ? 0.05 : 0.16}
      />
      {Array.from({ length: count }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the particle's identity (and its phase seed)
          key={i}
          r={1.6}
          fill={particleFill}
          className="flow-particle"
          style={{
            offsetPath: `path("${d}")`,
            animationDuration: `${duration}s`,
            // Negative delay = start mid-flight, so the rail is populated on
            // first paint instead of dribbling particles out of the source.
            animationDelay: `-${(seeded(id, i) * duration).toFixed(3)}s`,
            filter: `drop-shadow(0 0 2px ${particleFill})`,
          }}
        />
      ))}
      {Array.from({ length: reverseCount }, (_, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: the index IS the particle's identity (and its phase seed)
          key={`r${i}`}
          r={1.6}
          fill={particleFill}
          className="flow-particle-reverse"
          style={{
            offsetPath: `path("${d}")`,
            animationDuration: `${duration}s`,
            // A distinct seed namespace so the return stream doesn't mirror
            // the outbound one in lockstep.
            animationDelay: `-${(seeded(`${id}#r`, i) * duration).toFixed(3)}s`,
            filter: `drop-shadow(0 0 2px ${particleFill})`,
          }}
        />
      ))}
      {pulses.map((pulse) => (
        <circle
          key={pulse.key}
          r={pulse.money ? 3.4 : 2.6}
          fill={pulse.money ? MONEY_GOLD : pulseFill(pulse.lane)}
          className={pulse.reverse ? "flow-pulse-reverse" : "flow-pulse"}
          style={{
            offsetPath: `path("${d}")`,
            // No negative delay: a live pulse starts at ITS source end and
            // rides the rail once — the whole point is watching it depart.
            animationDuration: `${pulseDuration}s`,
            filter: `drop-shadow(0 0 5px ${
              pulse.money ? MONEY_GOLD : pulseFill(pulse.lane)
            })`,
          }}
          onAnimationEnd={() =>
            setPulses((prev) => prev.filter((p) => p.key !== pulse.key))
          }
        />
      ))}
    </g>
  );
}
