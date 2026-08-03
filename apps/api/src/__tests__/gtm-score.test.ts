import { afterEach, expect, it, vi } from "vitest";

// PURE test — no database, no network. It imports `src/workflows/gtm-score.ts`,
// which also defines a Hatchet task at module load, so the client is mocked out.
// Nothing in this file touches `runBatchedBackfill` or `ingestEvent`.
const hatchetMock = () => ({
  hatchet: {
    durableTask: vi.fn((config: Record<string, unknown>) => ({ ...config })),
    task: vi.fn((config: Record<string, unknown>) => ({ ...config })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { computeGtmScore } = await import("../workflows/gtm-score.js");
type GtmScoreInput = import("../workflows/gtm-score.js").GtmScoreInput;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Zero on every axis — the baseline an unknown, inert contact scores. */
const EMPTY: GtmScoreInput = {
  keyActions: 0,
  featureUses: 0,
  paidFeatureAttempts: 0,
  emailLinkClicks: 0,
  daysSinceLastActivity: null,
};

/** Every fit trait maxed: vp (20) + 250 employees (12) + software (10) + domain (5) = 47. */
const FULL_FIT: Partial<GtmScoreInput> = {
  refinedSeniority: "vp",
  refinedCompanyEmployees: 250,
  refinedCompanyIndustry: "software",
  refinedCompanyDomain: "acme.com",
};

/** Every behaviour axis at or past its cap: 20 + 10 + 12 + 8 = 50 raw. */
const FULL_BEHAVIOUR: Partial<GtmScoreInput> = {
  keyActions: 12,
  featureUses: 7,
  paidFeatureAttempts: 3,
  emailLinkClicks: 9,
  daysSinceLastActivity: 2,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// AC 2 — the score is a pure function of current contact state.
// ---------------------------------------------------------------------------

const CASES: Array<{ name: string; input: GtmScoreInput; expected: number }> = [
  {
    name: "no refined traits and no behaviour scores zero",
    input: EMPTY,
    expected: 0,
  },
  {
    name: "fit only (no behaviour) scores the fit half",
    input: { ...EMPTY, ...FULL_FIT },
    expected: 47,
  },
  {
    name: "behaviour only (no refined traits) scores the behaviour half",
    input: { ...EMPTY, ...FULL_BEHAVIOUR },
    expected: 50,
  },
  {
    name: "fit and behaviour together add",
    input: { ...EMPTY, ...FULL_FIT, ...FULL_BEHAVIOUR },
    expected: 97,
  },
  {
    name: "a non-numeric company_employees contributes nothing",
    // A jsonb bag can hold anything. `"250"` is a STRING, and neither this
    // function nor `conditions/property.ts` coerces — so the size band pays 0
    // and the fit half drops from 47 to 35.
    input: {
      ...EMPTY,
      ...FULL_FIT,
      refinedCompanyEmployees: "250",
    },
    expected: 35,
  },
  {
    name: "a null company_employees contributes nothing",
    input: { ...EMPTY, ...FULL_FIT, refinedCompanyEmployees: null },
    expected: 35,
  },
  {
    name: "an unrecognised seniority contributes nothing",
    input: { ...EMPTY, ...FULL_FIT, refinedSeniority: "intern" },
    expected: 27,
  },
  {
    name: "mid-tier fit bands score between the extremes",
    input: {
      ...EMPTY,
      refinedSeniority: "director",
      refinedCompanyEmployees: 60,
      refinedCompanyIndustry: "farming",
      refinedCompanyDomain: "acme.com",
    },
    expected: 25,
  },
  {
    name: "the recency input halves behaviour at 20 days idle",
    input: { ...EMPTY, ...FULL_BEHAVIOUR, daysSinceLastActivity: 20 },
    expected: 25,
  },
  {
    name: "behaviour is worth nothing once the recency input passes 30 days",
    input: { ...EMPTY, ...FULL_BEHAVIOUR, daysSinceLastActivity: 45 },
    expected: 0,
  },
  {
    name: "a null recency input zeroes behaviour but leaves fit intact",
    input: {
      ...EMPTY,
      ...FULL_FIT,
      ...FULL_BEHAVIOUR,
      daysSinceLastActivity: null,
    },
    expected: 47,
  },
  {
    name: "negative counts cannot drag the score below zero",
    input: { ...EMPTY, keyActions: -50, daysSinceLastActivity: 1 },
    expected: 0,
  },
];

for (const { name, input, expected } of CASES) {
  it(`AC 2: ${name}`, () => {
    expect(computeGtmScore(input)).toBe(expected);
  });
}

it("AC 2: the score is a NUMBER, never a string (law 2 — no coercion downstream)", () => {
  const score = computeGtmScore({ ...EMPTY, ...FULL_FIT });
  expect(typeof score).toBe("number");
  expect(Number.isInteger(score)).toBe(true);
  // A stringified score would silently never match `b.prop("gtmScore").gte(20)`.
  expect(score).not.toBe(String(score));
});

// ---------------------------------------------------------------------------
// AC 4 — determinism. Same input, same output, whatever the clock says.
// ---------------------------------------------------------------------------

it("AC 4: two calls on identical input return an identical score", () => {
  const input: GtmScoreInput = { ...EMPTY, ...FULL_FIT, ...FULL_BEHAVIOUR };
  expect(computeGtmScore(input)).toBe(computeGtmScore(input));
});

it("AC 4: advancing the system clock between calls does not change the score", () => {
  const input: GtmScoreInput = { ...EMPTY, ...FULL_FIT, ...FULL_BEHAVIOUR };

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const first = computeGtmScore(input);

  // Eighteen months later, mid-run. Decay must come from the explicit
  // `daysSinceLastActivity` argument, never from a read of the clock.
  vi.setSystemTime(new Date("2027-06-30T12:34:56.000Z"));
  const second = computeGtmScore(input);

  expect(second).toBe(first);
});

it("AC 4: the function consults neither Date.now nor Math.random", () => {
  const now = vi.spyOn(Date, "now");
  const random = vi.spyOn(Math, "random");

  computeGtmScore({ ...EMPTY, ...FULL_FIT, ...FULL_BEHAVIOUR });

  expect(now).not.toHaveBeenCalled();
  expect(random).not.toHaveBeenCalled();
});

it("AC 4: the input object is not mutated (no accumulation, law 1)", () => {
  const input: GtmScoreInput = { ...EMPTY, ...FULL_FIT, ...FULL_BEHAVIOUR };
  const snapshot = JSON.stringify(input);

  computeGtmScore(input);
  computeGtmScore(input);

  expect(JSON.stringify(input)).toBe(snapshot);
});
