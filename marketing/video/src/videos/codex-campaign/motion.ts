const clampedProgress = (frame: number, duration: number): number =>
  Math.max(0, Math.min(1, frame / Math.max(1, duration)));

const easeOutCubic = (value: number): number => 1 - (1 - value) ** 3;

export const snapZoom = (
  frame: number,
  duration: number,
  target: number,
): number => {
  const progress = easeOutCubic(clampedProgress(frame, duration));
  return 1 + (target - 1) * progress;
};

export const impactFlash = (localFrame: number): number =>
  localFrame >= 0 && localFrame < 2 ? 1 : 0;

export const directionalOffset = (
  frame: number,
  duration: number,
  direction: -1 | 1,
  distance = 120,
): number => {
  const progress = easeOutCubic(clampedProgress(frame, duration));
  if (progress >= 1) return 0;
  return direction * distance * (1 - progress);
};
