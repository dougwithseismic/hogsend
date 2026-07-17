import { createHash } from "node:crypto";

/**
 * Deterministic experiment-arm assignment for `ctx.variant` (impact
 * experiments, Decision B). NO RNG and NO clock — the replay law: journey
 * tasks replay-from-top on eviction/crash, so the same (journeyId, key,
 * userId) must bucket identically on every evaluation, forever. Mirrors
 * lib/holdout.ts (sha256 first 4 bytes → uniform 0-9999 bucket).
 */

/** key charset: jsonb object key + hash segment + future API query param. */
const VARIANT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Uniform 0-9999 bucket. Hash input is `variant:<journeyId>:<key>:<userId>`
 * — the `variant:` prefix + the key segment make this hash family DISJOINT
 * from holdoutBucket's `<salt>:<journeyId>:<userId>` (holdout.ts:17), so
 * variant assignment is statistically independent of holdout assignment.
 * `key` cannot contain `:` (validated), so segments are unambiguous.
 * FROZEN COMPATIBILITY CONTRACT under the replay law — locked by a
 * golden-value test; changing it re-buckets live experiments mid-flight.
 */
export function variantBucket(opts: {
  journeyId: string;
  key: string;
  userId: string;
}): number {
  const digest = createHash("sha256")
    .update(`variant:${opts.journeyId}:${opts.key}:${opts.userId}`)
    .digest();
  return digest.readUInt32BE(0) % 10000;
}

/**
 * Key-syntax-only check — runs BEFORE the recordOnce read (it gates the
 * jsonb path). Throws RangeError. 1-64 chars of [A-Za-z0-9_.-], starting
 * with a letter or digit; no `:` (it delimits the hash-input segments) and
 * no whitespace.
 */
export function validateVariantKey(key: string): void {
  if (!VARIANT_KEY_RE.test(key)) {
    throw new RangeError(
      `ctx.variant key "${key}" is invalid: 1-64 chars of [A-Za-z0-9_.-], ` +
        "starting with a letter or digit (no ':' — it delimits the hash " +
        "input; no spaces)",
    );
  }
}

/**
 * Arms validation — runs ONLY inside the compute path (see performVariant
 * in journeys/journey-context.ts): an enrollment with a recorded arm must
 * never crash on a later deploy that ships malformed arms. Throws
 * RangeError on: zero arms (JS callers; TS blocks via the tuple type),
 * empty/non-string arm, duplicate arms.
 */
export function validateVariantArms(arms: readonly string[]): void {
  if (arms.length === 0) {
    throw new RangeError("ctx.variant needs at least one arm");
  }
  for (const arm of arms) {
    if (typeof arm !== "string" || arm.length === 0) {
      throw new RangeError(
        `ctx.variant arms must be non-empty strings (got ${JSON.stringify(
          arm,
        )})`,
      );
    }
  }
  if (new Set(arms).size !== arms.length) {
    throw new RangeError(
      `ctx.variant arms contain duplicates: [${arms.join(", ")}]`,
    );
  }
}

/**
 * Deterministically pick one arm, equal split. Threshold for arm i is
 * Math.round(((i + 1) / arms.length) * 10000); the LAST arm is forced to
 * 10000 so rounding can never leave bucket 9999 unassigned. Weighted arms
 * are deliberately NOT supported (v1 = equal split; a weight edit would
 * remap buckets and reassign re-entrants of unlimited/once_per_period
 * journeys — see the impact-experiments design spec, D2).
 */
export function pickVariant(opts: {
  journeyId: string;
  key: string;
  userId: string;
  arms: readonly string[];
}): string {
  const bucket = variantBucket(opts);
  const n = opts.arms.length;
  for (let i = 0; i < n; i += 1) {
    const threshold = i === n - 1 ? 10000 : Math.round(((i + 1) / n) * 10000);
    if (bucket < threshold) return opts.arms[i] as string;
  }
  // Unreachable: the last threshold is 10000 and bucket < 10000.
  return opts.arms[n - 1] as string;
}
