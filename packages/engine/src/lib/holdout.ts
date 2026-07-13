import { createHash } from "node:crypto";

/**
 * Deterministic holdout assignment (docs/attribution-impact-plan.md §4.1).
 * NO RNG and NO clock — the replay law: journey tasks replay-from-top on
 * eviction/crash, so the same (userId, journeyId, salt) must bucket
 * identically on every evaluation, forever. sha256's first 4 bytes give a
 * uniform 0–9999 bucket; a contact is held out when their bucket falls
 * below percent × 100.
 */
export function holdoutBucket(opts: {
  userId: string;
  journeyId: string;
  salt?: string;
}): number {
  const digest = createHash("sha256")
    .update(`${opts.salt ?? opts.journeyId}:${opts.journeyId}:${opts.userId}`)
    .digest();
  return digest.readUInt32BE(0) % 10000;
}

export function isHeldOut(opts: {
  userId: string;
  journeyId: string;
  /** 0–50; values outside are clamped (a holdout is never the majority). */
  percent: number;
  salt?: string;
}): boolean {
  const percent = Math.min(50, Math.max(0, opts.percent));
  if (percent === 0) return false;
  return holdoutBucket(opts) < percent * 100;
}
