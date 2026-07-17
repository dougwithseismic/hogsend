import assert from "node:assert/strict";
import { test } from "node:test";
// Importing these modules IS the construction smoke: on zod 4.4.3 a
// discriminated union with a duplicated literal discriminator throws at
// CONSTRUCTION time, which would fail these imports (the landmine the
// `state` discriminator avoids).
import {
  globalControlSchema,
  journeyRowSchema,
  overviewResponseSchema,
} from "./impact.js";
import {
  impactResponseSchema,
  variantArmSchema,
  versionSchema,
} from "./journey-impact.js";

const verdict = {
  liftPercent: 12.5,
  winProbability: 0.9,
  suppressed: false,
  smallSample: true,
};
const counts = { contacts: 10, converters: 2, rate: 0.2 };
const cohort = { ...counts, value: [{ currency: "USD", value: 100 }] };

test("globalControlSchema parses all three states", () => {
  assert.equal(globalControlSchema.safeParse({ state: "off" }).success, true);
  assert.equal(
    globalControlSchema.safeParse({
      state: "skipped",
      reason: "too_many_contacts",
      percent: 5,
      contactCount: 600000,
    }).success,
    true,
  );
  assert.equal(
    globalControlSchema.safeParse({
      state: "computed",
      causal: true,
      percent: 5,
      contactsScanned: 1000,
      treatment: counts,
      control: counts,
      ...verdict,
    }).success,
    true,
  );
  // a fourth state is rejected
  assert.equal(
    globalControlSchema.safeParse({ state: "unknown" }).success,
    false,
  );
});

test("impactResponseSchema parses a full fixture", () => {
  const fixture = {
    journeyId: "j",
    days: 90,
    goal: { definitionId: "revenue", source: "goal", name: "Revenue" },
    holdout: { percent: 10 },
    currentVersionHash: "abcdefabcdef",
    currentVersionLabel: "v1",
    overall: { causal: true, treatment: cohort, control: cohort, verdict },
    versions: [
      {
        hash: "abcdefabcdef",
        label: "v1",
        firstEnrolledAt: "2026-07-01T00:00:00.000Z",
        lastEnrolledAt: "2026-07-10T00:00:00.000Z",
        enrollments: 10,
        converters: 2,
        rate: 0.2,
        liftVsControl: { causal: true, control: counts, ...verdict },
      },
    ],
    variants: [
      {
        key: "subject",
        arms: [
          {
            arm: "setup",
            enrollments: 5,
            converters: 1,
            rate: 0.2,
            engagement: { causal: false, sends: 5, opened: 2, clicked: 1 },
            liftVsControl: { causal: true, ...verdict },
          },
        ],
      },
    ],
  };
  assert.equal(impactResponseSchema.safeParse(fixture).success, true);
});

test("causal-language law is structural, not editorial", () => {
  const journeyRow = {
    journeyId: "j",
    name: null,
    registered: false,
    versionLabel: null,
    goalDefinitionId: null,
    holdoutPercent: null,
    observational: {
      causal: false,
      enrollments: 1,
      converters: 0,
      rate: 0,
    },
    attributed: { causal: false, model: "linear", values: [] },
    lift: { causal: true, control: counts, ...verdict },
  };
  assert.equal(journeyRowSchema.safeParse(journeyRow).success, true);
  // observational block can NEVER claim causality
  assert.equal(
    journeyRowSchema.safeParse({
      ...journeyRow,
      observational: { ...journeyRow.observational, causal: true },
    }).success,
    false,
  );
  // the holdout-backed lift block can NEVER be labeled observational
  assert.equal(
    journeyRowSchema.safeParse({
      ...journeyRow,
      lift: { ...journeyRow.lift, causal: false },
    }).success,
    false,
  );
  // variant engagement is observational by type
  assert.equal(
    variantArmSchema.safeParse({
      arm: "a",
      enrollments: 1,
      converters: 0,
      rate: 0,
      engagement: { causal: true, sends: 0, opened: 0, clicked: 0 },
      liftVsControl: null,
    }).success,
    false,
  );
  // version liftVsControl is causal by type
  assert.equal(
    versionSchema.safeParse({
      hash: null,
      label: null,
      firstEnrolledAt: null,
      lastEnrolledAt: null,
      enrollments: 0,
      converters: 0,
      rate: 0,
      liftVsControl: { causal: false, control: counts, ...verdict },
    }).success,
    false,
  );
  // the campaigns SECTION is correlational-only by type
  const overview = {
    days: 90,
    model: "linear",
    rankedBy: "converters",
    journeys: [],
    campaigns: { causal: false, rows: [] },
    globalControl: { state: "off" },
  };
  assert.equal(overviewResponseSchema.safeParse(overview).success, true);
  assert.equal(
    overviewResponseSchema.safeParse({
      ...overview,
      campaigns: { causal: true, rows: [] },
    }).success,
    false,
  );
  assert.equal(
    overviewResponseSchema.safeParse({
      ...overview,
      rankedBy: "enrollments",
    }).success,
    false,
  );
});
