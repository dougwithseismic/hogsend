/**
 * Framework-free motion math for native marketing clips — a faithful port
 * of the Remotion primitives used by the journey-trace engine
 * (marketing/video/src/lib/anim.tsx + the local GLIDE helper in
 * videos/journey-clips/trace.tsx).
 *
 * Every helper takes an explicit `frame` argument — there are NO Remotion
 * hooks here. The looping web clock (use-loop-frame.ts) supplies `frame`.
 */

// ---------------------------------------------------------------------------
// clamp + interpolate — reproduce Remotion's `interpolate` semantics.
// ---------------------------------------------------------------------------

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

type ExtrapolateType = "clamp" | "extend" | "identity";

export type InterpolateOptions = {
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
};

/**
 * Linear interpolation matching Remotion's `interpolate(input, inputRange,
 * outputRange, options?)`. Both ranges are 2-element here (the only shape
 * the clips use). `extrapolateLeft` / `extrapolateRight` default to
 * "extend" (Remotion's default), with "clamp" and "identity" supported.
 */
export const interpolate = (
  input: number,
  inputRange: readonly [number, number],
  outputRange: readonly [number, number],
  options: InterpolateOptions = {},
): number => {
  const { extrapolateLeft = "extend", extrapolateRight = "extend" } = options;
  const [inMin, inMax] = inputRange;
  const [outMin, outMax] = outputRange;

  // Below the left edge.
  if (input < inMin) {
    if (extrapolateLeft === "identity") return input;
    if (extrapolateLeft === "clamp") return outMin;
  }
  // Above the right edge.
  if (input > inMax) {
    if (extrapolateRight === "identity") return input;
    if (extrapolateRight === "clamp") return outMax;
  }

  // Degenerate input range — avoid divide-by-zero.
  if (inMax === inMin) {
    return input <= inMin ? outMin : outMax;
  }

  return outMin + ((input - inMin) / (inMax - inMin)) * (outMax - outMin);
};

// ---------------------------------------------------------------------------
// spring — a damped-harmonic approximation close to Remotion's spring.
// ---------------------------------------------------------------------------

export type SpringConfig = {
  damping?: number;
  mass?: number;
  stiffness?: number;
  overshootClamping?: boolean;
};

const DEFAULT_SPRING: Required<SpringConfig> = {
  damping: 10,
  mass: 1,
  stiffness: 100,
  overshootClamping: false,
};

/**
 * Analytic 0→1 damped-spring solution (under/critical/over-damped), the
 * same closed form Remotion's spring resolves to for `from:0, to:1`. When
 * `durationInFrames` is given, the natural frame is time-stretched so the
 * spring lands at ~1 exactly at the end of that window (Remotion's
 * duration behaviour).
 */
export const spring = ({
  frame,
  fps,
  config = {},
  durationInFrames,
}: {
  frame: number;
  fps: number;
  config?: SpringConfig;
  durationInFrames?: number;
}): number => {
  const { damping, mass, stiffness, overshootClamping } = {
    ...DEFAULT_SPRING,
    ...config,
  };

  if (frame <= 0) return 0;

  // Natural-duration time-stretch: Remotion compresses the spring's own
  // settle time into `durationInFrames`. We approximate the natural settle
  // at ~24 frames-equivalent and rescale so the curve reaches 1 by the end.
  const naturalFrames = 24;
  const t =
    durationInFrames != null
      ? (frame / durationInFrames) * naturalFrames
      : frame;

  const time = t / fps;

  const w0 = Math.sqrt(stiffness / mass); // undamped angular frequency
  const zeta = damping / (2 * Math.sqrt(stiffness * mass)); // damping ratio

  // Initial conditions for a 0→1 step with zero initial velocity:
  // displacement starts at -1 (distance to the target) and decays to 0.
  let value: number;
  if (zeta < 1) {
    // Underdamped — oscillatory settle.
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * w0 * time);
    value =
      1 -
      envelope *
        (Math.cos(wd * time) + ((zeta * w0) / wd) * Math.sin(wd * time));
  } else if (zeta === 1) {
    // Critically damped.
    const envelope = Math.exp(-w0 * time);
    value = 1 - envelope * (1 + w0 * time);
  } else {
    // Overdamped — sum of two decaying exponentials.
    const r = w0 * Math.sqrt(zeta * zeta - 1);
    const a = -zeta * w0 + r;
    const b = -zeta * w0 - r;
    const c1 = (b * 1) / (b - a);
    const c2 = 1 - c1;
    value = 1 - (c1 * Math.exp(a * time) + c2 * Math.exp(b * time));
  }

  if (overshootClamping) {
    value = value < 1 ? value : 1;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Spring configs (same language as the launch videos).
// ---------------------------------------------------------------------------

/** High-damping, clean non-wobbly motion. */
export const SPRING_SNAPPY = { damping: 200, mass: 0.6 } as const;
/** Snappy element pop-in. */
export const SPRING_POP = { damping: 200, mass: 0.4 } as const;
/** Soft glide used by the rail rows + code band (trace.tsx GLIDE). */
export const GLIDE = { damping: 15, mass: 0.6, stiffness: 130 } as const;

// ---------------------------------------------------------------------------
// Named helpers — every one takes an explicit `frame`.
// ---------------------------------------------------------------------------

/** 0→1 spring progress for an element popping in. */
export const pop = (frame: number, fps: number, delay = 0): number =>
  spring({
    frame: frame - delay,
    fps,
    config: SPRING_POP,
    durationInFrames: 14,
  });

/** Soft glide 0→1 (rail rows, code band moves). GLIDE config, 24 frames. */
export const glide = (frame: number, fps: number, delay = 0): number =>
  spring({ frame: frame - delay, fps, config: GLIDE, durationInFrames: 24 });

/**
 * Beat-change punch-in: scale 1.04→1.00 over the first few frames of a
 * beat. Apply to the beat's root element via `transform: scale(...)`.
 */
export const punchIn = (frame: number, fps: number): number => {
  const p = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 8,
  });
  return interpolate(p, [0, 1], [1.04, 1]);
};

/** Spring-driven slide-up; returns { opacity, translateY } in px. */
export const slideUp = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 28,
): { opacity: number; translateY: number } => {
  const p = pop(frame, fps, delay);
  return {
    opacity: p,
    translateY: interpolate(p, [0, 1], [distance, 0]),
  };
};
