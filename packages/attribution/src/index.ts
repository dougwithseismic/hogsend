import type { TouchpointChannel } from "@hogsend/core";

/**
 * Multi-model revenue attribution —
 * pure functions from an ordered touchpoint path to per-touchpoint credit
 * weights. No I/O, no clock reads: everything comes in as arguments, so the
 * engine can compute EVERY model at conversion time and persist the credits
 * as a ledger (`attribution_credits`) instead of re-deriving history when
 * someone changes their mind about a model.
 *
 * Weights for one (model, conversion) always sum to 1 (within float
 * tolerance); a model that cannot allocate (empty path) returns [].
 */

export interface AttributionTouchpoint {
  /** The `user_events` row id — the credit ledger's join key. */
  id: string;
  /** Event name (a touchpoint class — see @hogsend/core TOUCHPOINT_EVENT_CLASSES). */
  event: string;
  /** The touchpoint's marketing channel. */
  channel: TouchpointChannel;
  /** When the touch happened (epoch ms). */
  occurredAt: number;
}

export interface AttributionCredit {
  touchpointId: string;
  /** Fraction of the conversion this touch earns; one model's sum = 1. */
  weight: number;
}

export const ATTRIBUTION_MODELS = [
  "first",
  "last",
  "lastNonDirect",
  "linear",
  "timeDecay",
  "positionU",
  "positionW",
  "blended",
] as const;

export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export interface ComputeCreditsOptions {
  /** When the conversion happened (epoch ms) — time-decay's anchor. */
  conversionAt: number;
  /** Time-decay half-life in days. Default 7. */
  halfLifeDays?: number;
  /**
   * Channels `lastNonDirect` skips (the touch that IS the conversion
   * milestone rather than what drove it). Default: `["form"]` — the form
   * submit is the goal line, not the marketing touch.
   */
  nonDirectExcludes?: readonly TouchpointChannel[];
  /** Models averaged by `blended`. Default: linear, timeDecay, positionU. */
  blend?: readonly Exclude<AttributionModel, "blended">[];
}

/** Normalize raw scores into weights summing to 1 (empty in → empty out). */
function normalize(
  touchpoints: readonly AttributionTouchpoint[],
  scores: readonly number[],
): AttributionCredit[] {
  const total = scores.reduce((sum, s) => sum + s, 0);
  if (total <= 0) return [];
  return touchpoints.map((t, i) => ({
    touchpointId: t.id,
    weight: (scores[i] as number) / total,
  }));
}

/** 100% to one index. */
function single(
  touchpoints: readonly AttributionTouchpoint[],
  index: number,
): AttributionCredit[] {
  const t = touchpoints[index];
  return t ? [{ touchpointId: t.id, weight: 1 }] : [];
}

/**
 * Compute one model's credits over a chronologically ASCENDING touchpoint
 * path. Callers sort; this function trusts the order (and re-sorting here
 * would hide caller bugs).
 */
export function computeCredits(
  model: AttributionModel,
  touchpoints: readonly AttributionTouchpoint[],
  opts: ComputeCreditsOptions,
): AttributionCredit[] {
  const n = touchpoints.length;
  if (n === 0) return [];

  switch (model) {
    case "first":
      return single(touchpoints, 0);

    case "last":
      return single(touchpoints, n - 1);

    case "lastNonDirect": {
      const excludes = opts.nonDirectExcludes ?? ["form"];
      for (let i = n - 1; i >= 0; i--) {
        const t = touchpoints[i] as AttributionTouchpoint;
        if (!excludes.includes(t.channel)) return single(touchpoints, i);
      }
      // Every touch is excluded-class — fall back to plain last.
      return single(touchpoints, n - 1);
    }

    case "linear":
      return normalize(
        touchpoints,
        touchpoints.map(() => 1),
      );

    case "timeDecay": {
      const halfLifeMs = (opts.halfLifeDays ?? 7) * 24 * 60 * 60 * 1000;
      return normalize(
        touchpoints,
        touchpoints.map((t) => {
          const age = Math.max(0, opts.conversionAt - t.occurredAt);
          return 2 ** (-age / halfLifeMs);
        }),
      );
    }

    case "positionU": {
      // 40% first, 40% last, 20% split across the middle. Normalization
      // makes the small paths right on its own: one touch takes 100%, two
      // touches split 50/50 (both are anchors; the middle branch is
      // unreachable, so no n-2 division happens).
      return normalize(
        touchpoints,
        touchpoints.map((_, i) =>
          i === 0 || i === n - 1 ? 0.4 : 0.2 / (n - 2),
        ),
      );
    }

    case "positionW": {
      // W-shaped: 30% first touch, 30% lead creation (the latest `form`
      // touch), 30% last touch, 10% across everything else. Anchors that
      // coincide (or a missing lead anchor) simply pool their mass via
      // normalization — which also makes a single-touch path take 100%.
      let leadIndex = -1;
      for (let i = n - 1; i >= 0; i--) {
        if ((touchpoints[i] as AttributionTouchpoint).channel === "form") {
          leadIndex = i;
          break;
        }
      }
      const anchors = new Set([
        0,
        n - 1,
        ...(leadIndex >= 0 ? [leadIndex] : []),
      ]);
      const middles = n - anchors.size;
      return normalize(
        touchpoints,
        touchpoints.map((_, i) =>
          anchors.has(i) ? 0.3 : middles > 0 ? 0.1 / middles : 0,
        ),
      );
    }

    case "blended": {
      const parts = opts.blend ?? ["linear", "timeDecay", "positionU"];
      const byId = new Map<string, number>();
      for (const part of parts) {
        for (const credit of computeCredits(part, touchpoints, opts)) {
          byId.set(
            credit.touchpointId,
            (byId.get(credit.touchpointId) ?? 0) + credit.weight,
          );
        }
      }
      return normalize(
        touchpoints,
        touchpoints.map((t) => byId.get(t.id) ?? 0),
      );
    }
  }
}

/**
 * Every model's credits in one pass — what the engine persists at
 * conversion time. Returns a map so a missing path yields empty arrays,
 * never a throw.
 */
export function computeAllModels(
  touchpoints: readonly AttributionTouchpoint[],
  opts: ComputeCreditsOptions,
): Record<AttributionModel, AttributionCredit[]> {
  const out = {} as Record<AttributionModel, AttributionCredit[]>;
  for (const model of ATTRIBUTION_MODELS) {
    out[model] = computeCredits(model, touchpoints, opts);
  }
  return out;
}
