import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CohortCounts, LiftVerdict } from "@/lib/admin-api";
import {
  formatAmountWithCode,
  formatNumber,
  formatPercent,
} from "@/lib/format";

/**
 * Honest-rendering primitives for impact numbers — the causal-language law
 * (engine routes/admin/funnels.ts:16) in pixels. The journey Impact card AND
 * the /impact overview both import from here so the rules cannot drift.
 *
 * Crimzon single-accent, dark-only: NO green/amber. Direction is sign +
 * chevron; confidence is win-probability text.
 */

/** Bright "Causal" vs dim "Observational" — rendered next to EVERY
 * lift/rate figure. */
export function CausalBadge({ causal }: { causal: boolean }) {
  return causal ? (
    <Badge
      variant="outline"
      className="border-white/30 bg-white/[0.08] text-white"
    >
      Causal
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="border-white/[0.08] bg-white/[0.03] text-white/45"
    >
      Observational
    </Badge>
  );
}

/** "N contacts · K converters · R%" plus a per-currency value strip —
 * one span per currency, NEVER summed across currencies. */
export function CohortLine({
  label,
  cohort,
}: {
  label: string;
  cohort: CohortCounts & {
    value?: Array<{ currency: string | null; value: number }>;
  };
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="w-28 shrink-0 text-white/50">{label}</span>
      <span className="tabular-nums text-white/90">
        {formatNumber(cohort.contacts)} contacts ·{" "}
        {formatNumber(cohort.converters)} converters ·{" "}
        {formatPercent(cohort.rate)}
      </span>
      {(cohort.value ?? []).map((v) => (
        <span
          key={v.currency ?? "__none__"}
          className="text-xs tabular-nums text-white/50"
        >
          {formatAmountWithCode(v.value, v.currency)}
        </span>
      ))}
    </div>
  );
}

/**
 * The four LiftValue states, exact rules (spec D6):
 *  1. verdict === null → "—" (no control cohort; no causal number exists).
 *  2. suppressed → "Collecting — {n} of 10 conversions needed". NEVER the
 *     percentage: under 10 combined conversions it is noise wearing a
 *     percentage sign (lift-stats.ts:12). winProbability is already null.
 *  3. liftPercent === null and NOT suppressed (control converts at 0% with
 *     ≥10 combined conversions) → "n/a — control converts at 0% · P% win
 *     probability" — the engine still computes winProbability here
 *     (lift-stats.ts:113-120; null only when suppressed) and it is exactly
 *     the causal number the law permits; do not drop it.
 *  4. otherwise → sign + |liftPercent|.toFixed(1)% with a chevron; append
 *     "· P% win probability" when non-null; append "· small sample (<100
 *     per cohort)" when smallSample.
 *
 * SCALING HAZARD: engine liftPercent is ALREADY ×100 (lift-stats.ts:109-111)
 * → toFixed(1) directly. Cohort rates are 0–1 fractions → formatPercent.
 * The literals 10 and 100 duplicate MIN_COMBINED_CONVERSIONS /
 * SMALL_SAMPLE_FLOOR (lift-stats.ts:18-19); Studio cannot import engine
 * packages — keep them in sync by hand.
 */
export function LiftValue({
  verdict,
  combinedConversions,
}: {
  verdict: LiftVerdict | null;
  combinedConversions?: number;
}) {
  if (verdict === null) {
    return <span className="text-white/40">—</span>;
  }
  if (verdict.suppressed) {
    return (
      <span className="text-white/60">
        Collecting — {formatNumber(combinedConversions ?? 0)} of 10 conversions
        needed
      </span>
    );
  }
  if (verdict.liftPercent === null) {
    return (
      <span className="text-white/70">
        n/a — control converts at 0%
        {verdict.winProbability !== null
          ? ` · ${(verdict.winProbability * 100).toFixed(0)}% win probability`
          : null}
      </span>
    );
  }
  const up = verdict.liftPercent >= 0;
  const Chevron = up ? ChevronUp : ChevronDown;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-white/90">
      <Chevron className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
      <span className="tabular-nums">
        {up ? "+" : "−"}
        {Math.abs(verdict.liftPercent).toFixed(1)}%
      </span>
      {verdict.winProbability !== null ? (
        <span className="text-white/50">
          · {(verdict.winProbability * 100).toFixed(0)}% win probability
        </span>
      ) : null}
      {verdict.smallSample ? (
        <span className="text-white/50">
          · small sample (&lt;100 per cohort)
        </span>
      ) : null}
    </span>
  );
}
