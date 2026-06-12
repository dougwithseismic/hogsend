/**
 * Deterministic typewriter timing shared by CodeScene and Terminal.
 * Each character has a "cost" in ticks; line ends cost more, creating
 * natural micro-pauses. `charsVisible` maps a frame to a char count.
 */

const costOf = (char: string, next: string | undefined): number => {
  if (char === "\n") return 7; // micro-pause at line end
  if (next === "\n" && (char === ";" || char === "{" || char === ")")) {
    return 2.5;
  }
  if (char === " ") return 0.7;
  return 1;
};

/** Cumulative tick cost for each char index of `text`. */
export const cumulativeCosts = (text: string): number[] => {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc += costOf(text[i] as string, text[i + 1]);
    out.push(acc);
  }
  return out;
};

/**
 * How many characters of `text` are visible at `frame`.
 * `speed` = ticks revealed per frame (≈ chars/frame for normal chars).
 */
export const charsVisible = (
  text: string,
  frame: number,
  speed = 2.4,
  startDelay = 0,
): number => {
  if (frame < startDelay) return 0;
  const budget = (frame - startDelay) * speed;
  const costs = cumulativeCosts(text);
  // binary search for the last index whose cumulative cost <= budget
  let lo = 0;
  let hi = costs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((costs[mid] as number) <= budget) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Total frames the typewriter needs to finish typing `text`. */
export const typingDuration = (
  text: string,
  speed = 2.4,
  startDelay = 0,
): number => {
  const costs = cumulativeCosts(text);
  const total = costs.length > 0 ? (costs[costs.length - 1] as number) : 0;
  return Math.ceil(total / speed) + startDelay;
};
