function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function progress(frame: number, from: number, duration: number) {
  if (duration <= 0) return frame >= from ? 1 : 0;
  return clamp01((frame - from) / duration);
}

export function easeOutCubic(value: number) {
  const clamped = clamp01(value);
  return 1 - (1 - clamped) ** 3;
}

export function windowedProgress(
  frame: number,
  enter: number,
  hold: number,
  exit: number,
) {
  const entered = progress(frame, enter, exit);
  const exiting = 1 - progress(frame, enter + hold, exit);
  return clamp01(Math.min(entered, exiting));
}
