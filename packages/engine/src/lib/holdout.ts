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

/**
 * Global control group (impact plan §4.3) — a contact-level bucket excluded
 * from ALL non-transactional email/SMS sends, for program-level lift.
 * Operator opt-in via `GLOBAL_CONTROL_PERCENT` (0 = off, clamped to 15 —
 * the industry ceiling; Braze allows 1–15%). Explicitly optional: at SMB
 * volume the per-journey holdout is the workhorse. `GLOBAL_CONTROL_SALT`
 * rotation re-buckets the population.
 */
export function globalControlPercent(): number {
  const raw = Number(process.env.GLOBAL_CONTROL_PERCENT ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(15, raw);
}

/**
 * Whether the send identity (`userId` when known, else the recipient
 * address) is in the global control group. Same determinism contract as
 * {@link holdoutBucket}; case-normalized so an email key is stable.
 */
export function isGlobalControl(key: string): boolean {
  const percent = globalControlPercent();
  if (percent === 0) return false;
  const digest = createHash("sha256")
    .update(
      `${process.env.GLOBAL_CONTROL_SALT ?? "global-control"}:GLOBAL:${key.toLowerCase()}`,
    )
    .digest();
  return digest.readUInt32BE(0) % 10000 < percent * 100;
}
