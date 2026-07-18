/**
 * Impact experiments — dogfood adoption matrix + invariants (spec D7).
 *
 * Pure meta assertions over the exported arrays — no DB, no Hatchet run, no
 * app boot. Two layers:
 *
 *  - the ADOPTION MATRIX pins: which journeys hold out at what percent,
 *    which goals they bind, which version labels they carry (a deleted
 *    holdout or renamed goal fails HERE, loudly);
 *  - the three D7 INVARIANTS:
 *    (1) every `goal` names a registered conversion or the seeded
 *        zero-config "revenue" conversion;
 *    (2) every holdout has 0 < percent <= 50 AND carries a goal + version
 *        label — a holdout without a goal has no default readout, and one
 *        without a label loses cohort continuity across content epochs;
 *    (3) unlimited-entry journeys never carry a holdout — the
 *        ENROLLMENT-UNIT MISMATCH: an unlimited journey gives treated
 *        users one state row per enrollment while a held-out user gets
 *        exactly ONE held_out row ever, so the lift comparison would be
 *        enrollments-vs-contacts with skewed denominators. (NOT row spam —
 *        the engine dedupes held_out rows once-ever per (user, journey).)
 */
import { describe, expect, it } from "vitest";
import { conversions } from "../conversions/index.js";
import { journeys } from "../journeys/index.js";

// The seeded zero-config "revenue" conversion registers whenever
// HOGSEND_DEFAULT_REVENUE_CONVERSION !== "false" and no authored definition
// claims id "revenue" (engine container seed). This deployment does neither,
// so "revenue" is a valid goal target here.
const KNOWN_CONVERSION_IDS = new Set([
  ...conversions.map((def) => def.meta.id),
  "revenue",
]);

// D7 matrix: 10% on steady lifecycle journeys; 15% on winbacks (effects are
// small and withholding from dormant users is cheap — a bigger control buys
// resolution). No salt anywhere: the journey-id default is correct and
// rotation is a deliberate future action, never an accident.
const HOLDOUT_MATRIX: Record<string, { percent: number; goal: string }> = {
  "activation-welcome": { percent: 10, goal: "revenue" },
  "activation-nudge-series": { percent: 10, goal: "revenue" },
  "ai-onboarding": { percent: 10, goal: "revenue" },
  "conversion-trial-upgrade": { percent: 10, goal: "revenue" },
  "conversion-abandoned-checkout": { percent: 10, goal: "revenue" },
  "reactivation-dormancy": { percent: 15, goal: "revenue" },
  "ai-reengagement": { percent: 15, goal: "revenue" },
};

// Goal without holdout: dunning is quasi-transactional (withholding
// payment-failure notices is forfeited revenue, not learning); the link
// campaign is the one lead-shaped binding in this app.
const GOAL_ONLY_MATRIX: Record<string, string> = {
  "churn-prevention": "revenue",
  "link-click-campaign": "lead-submitted",
};

const VERSIONED_IDS = [
  ...Object.keys(HOLDOUT_MATRIX),
  ...Object.keys(GOAL_ONLY_MATRIX),
];

function metaOf(id: string) {
  const journey = journeys.find((j) => j.meta.id === id);
  if (!journey) {
    throw new Error(`journey "${id}" not found in the journeys array`);
  }
  return journey.meta;
}

describe("impact meta — D7 adoption matrix", () => {
  it("the seven holdout journeys carry the exact percent + goal", () => {
    for (const [id, expected] of Object.entries(HOLDOUT_MATRIX)) {
      const meta = metaOf(id);
      expect(meta.holdout, `${id} holdout`).toEqual({
        percent: expected.percent,
      });
      expect(meta.goal, `${id} goal`).toBe(expected.goal);
    }
  });

  it("the two goal-only journeys declare a goal and NO holdout", () => {
    for (const [id, goal] of Object.entries(GOAL_ONLY_MATRIX)) {
      const meta = metaOf(id);
      expect(meta.goal, `${id} goal`).toBe(goal);
      expect(meta.holdout, `${id} must not hold out`).toBeUndefined();
    }
  });

  it("all nine touched journeys carry the date-stamped version label", () => {
    expect(metaOf("activation-welcome").version).toBe(
      "2026-07-welcome-subject-ab",
    );
    for (const id of VERSIONED_IDS) {
      if (id === "activation-welcome") continue;
      expect(metaOf(id).version, `${id} version`).toBe("2026-07-baseline");
    }
  });

  it("no journey outside the matrix holds out (nps feeds detractor-rescue; digest, low-volume, connector, demo and test journeys stay untouched)", () => {
    const allowed = new Set(Object.keys(HOLDOUT_MATRIX));
    for (const journey of journeys) {
      if (allowed.has(journey.meta.id)) continue;
      expect(
        journey.meta.holdout,
        `${journey.meta.id} must not hold out`,
      ).toBeUndefined();
    }
  });
});

describe("impact meta — D7 invariants", () => {
  it("(1) every declared goal names a registered conversion or the seeded revenue", () => {
    for (const journey of journeys) {
      const goal = journey.meta.goal;
      if (goal === undefined) continue;
      expect(
        KNOWN_CONVERSION_IDS.has(goal),
        `${journey.meta.id} goal "${goal}" is not one of: ${[
          ...KNOWN_CONVERSION_IDS,
        ].join(", ")}`,
      ).toBe(true);
    }
  });

  it("(2) every holdout has 0 < percent <= 50 and carries a goal + version label", () => {
    for (const journey of journeys) {
      const holdout = journey.meta.holdout;
      if (!holdout) continue;
      const id = journey.meta.id;
      expect(holdout.percent, `${id} percent`).toBeGreaterThan(0);
      expect(holdout.percent, `${id} percent`).toBeLessThanOrEqual(50);
      expect(
        journey.meta.goal,
        `${id}: a holdout without a goal has no default readout`,
      ).toBeDefined();
      expect(
        journey.meta.version,
        `${id}: a holdout without a version label loses cohort continuity`,
      ).toBeDefined();
    }
  });

  it("(3) unlimited-entry journeys never hold out — the enrollment-unit mismatch (per-enrollment treated rows vs ONE held_out row ever skews lift denominators)", () => {
    for (const journey of journeys) {
      if (journey.meta.entryLimit !== "unlimited") continue;
      expect(
        journey.meta.holdout,
        `${journey.meta.id} is unlimited-entry`,
      ).toBeUndefined();
    }
  });
});
