/**
 * Holdout lift statistics: Bayesian beta-binomial with a uniform Beta(1,1)
 * prior — the
 * lean, honest method at self-hosted volumes. Win probability is
 * P(treatment rate > control rate) under independent posteriors
 * Beta(k+1, n−k+1), computed by DETERMINISTIC numeric integration (no
 * sampling — stable across runs and trivially testable).
 *
 * Presentation guards, per the plan's honesty stance:
 *  - suppression floor: fewer than {@link MIN_COMBINED_CONVERSIONS} combined
 *    conversions ⇒ no win probability at all (Klaviyo suppresses at the same
 *    threshold; below it the number is noise wearing a percentage sign);
 *  - small-sample flag: either cohort under {@link SMALL_SAMPLE_FLOOR}
 *    contacts ⇒ `smallSample: true` so surfaces can warn loudly (Braze's
 *    rule of thumb is ~1,000; we present rather than lock out).
 */

export const MIN_COMBINED_CONVERSIONS = 10;
export const SMALL_SAMPLE_FLOOR = 100;

/** Integration grid — 2001 points is ample at any realistic cohort size. */
const GRID = 2001;

function logGamma(x: number): number {
  // Lanczos approximation (g=7, n=9) — standard coefficients.
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xShifted = x - 1;
  let sum = coefficients[0] as number;
  for (let i = 1; i < coefficients.length; i++) {
    sum += (coefficients[i] as number) / (xShifted + i);
  }
  const t = xShifted + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (xShifted + 0.5) * Math.log(t) -
    t +
    Math.log(sum)
  );
}

function logBetaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return Number.NEGATIVE_INFINITY;
  return (
    (a - 1) * Math.log(x) +
    (b - 1) * Math.log(1 - x) +
    logGamma(a + b) -
    logGamma(a) -
    logGamma(b)
  );
}

/**
 * P(X > Y) for X ~ Beta(a1,b1), Y ~ Beta(a2,b2): midpoint-rule integration
 * of ∫ f_X(x)·F_Y(x) dx. Midpoints (never 0 or 1) sidestep the boundary —
 * Beta pdfs are singular or discontinuous there for shape params ≤ 1, which
 * a trapezoid pass silently truncates.
 */
export function betaWinProbability(
  a1: number,
  b1: number,
  a2: number,
  b2: number,
): number {
  const dx = 1 / GRID;
  let cdfY = 0;
  let p = 0;
  for (let i = 0; i < GRID; i++) {
    const x = (i + 0.5) * dx;
    const massY = Math.exp(logBetaPdf(x, a2, b2)) * dx;
    // F_Y at this midpoint ≈ mass through the previous cells + half this one.
    const cdfAtX = cdfY + massY / 2;
    p += Math.exp(logBetaPdf(x, a1, b1)) * cdfAtX * dx;
    cdfY += massY;
  }
  // Clamp tiny numeric drift.
  return Math.min(1, Math.max(0, p));
}

export interface LiftVerdict {
  /** (treatmentRate − controlRate) / controlRate; null when control is 0. */
  liftPercent: number | null;
  /** P(treatment > control); null when suppressed. */
  winProbability: number | null;
  /** True when combined conversions are under the suppression floor. */
  suppressed: boolean;
  /** True when either cohort is under the small-sample floor. */
  smallSample: boolean;
}

export function computeLift(opts: {
  treatment: { contacts: number; converters: number };
  control: { contacts: number; converters: number };
}): LiftVerdict {
  const { treatment, control } = opts;
  const treatmentRate =
    treatment.contacts > 0 ? treatment.converters / treatment.contacts : 0;
  const controlRate =
    control.contacts > 0 ? control.converters / control.contacts : 0;
  const suppressed =
    treatment.converters + control.converters < MIN_COMBINED_CONVERSIONS;
  return {
    liftPercent:
      controlRate > 0
        ? ((treatmentRate - controlRate) / controlRate) * 100
        : null,
    winProbability: suppressed
      ? null
      : betaWinProbability(
          treatment.converters + 1,
          treatment.contacts - treatment.converters + 1,
          control.converters + 1,
          control.contacts - control.converters + 1,
        ),
    suppressed,
    smallSample:
      Math.min(treatment.contacts, control.contacts) < SMALL_SAMPLE_FLOOR,
  };
}
