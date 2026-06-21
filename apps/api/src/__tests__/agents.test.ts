/**
 * Unit tests for the AI agent modules.
 *
 * `ai` is mocked so these run offline with no API key. The mock returns a
 * fixed `object` that satisfies `OnboardingPlan`; the test asserts the agent
 * function unwraps and returns it correctly.
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock the `ai` module before importing the agent.
// ---------------------------------------------------------------------------

const FIXED_PLAN = {
  subject: "Welcome — here's where to start",
  body: "Based on your setup, we think you'll get the most out of the journey builder.",
  tips: ["Define your first journey", "Connect your PostHog project"],
  featureToActivate: "the journey builder",
};

vi.mock("ai", () => ({
  generateObject: vi.fn().mockResolvedValue({ object: FIXED_PLAN }),
}));

// Mock `@ai-sdk/anthropic` so `createAnthropic()` doesn't need a real key.
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({
    modelId,
    provider: "anthropic",
  })),
}));

// Import after mocks are registered.
const { draftOnboardingPlan, OnboardingPlan } = await import(
  "../agents/onboarding-concierge.js"
);

// ---------------------------------------------------------------------------
// Minimal UserContext stub
// ---------------------------------------------------------------------------

const minimalContext = {
  contact: {
    id: "user-123",
    email: "ada@example.com",
    properties: { plan: "free" },
  },
  events: [
    {
      event: "user.created",
      properties: { source: "signup" },
      occurredAt: new Date().toISOString(),
    },
  ],
  email: {
    everOpened: false,
    everClicked: false,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("draftOnboardingPlan()", () => {
  it("returns an object that satisfies the OnboardingPlan schema", async () => {
    const plan = await draftOnboardingPlan(minimalContext);
    const result = OnboardingPlan.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("returns the fixed mock plan unchanged", async () => {
    const plan = await draftOnboardingPlan(minimalContext);
    expect(plan.subject).toBe(FIXED_PLAN.subject);
    expect(plan.body).toBe(FIXED_PLAN.body);
    expect(plan.tips).toEqual(FIXED_PLAN.tips);
    expect(plan.featureToActivate).toBe(FIXED_PLAN.featureToActivate);
  });

  it("plan has 1–3 tips", async () => {
    const plan = await draftOnboardingPlan(minimalContext);
    expect(plan.tips.length).toBeGreaterThanOrEqual(1);
    expect(plan.tips.length).toBeLessThanOrEqual(3);
  });

  it("subject is a non-empty string", async () => {
    const plan = await draftOnboardingPlan(minimalContext);
    expect(typeof plan.subject).toBe("string");
    expect(plan.subject.length).toBeGreaterThan(0);
  });

  it("works with a context that has no posthog props", async () => {
    const plan = await draftOnboardingPlan(minimalContext);
    expect(plan).toBeDefined();
  });

  it("works with a context that includes posthog props", async () => {
    const ctxWithPosthog = {
      ...minimalContext,
      posthog: { industry: "saas", role: "engineer" },
    };
    const plan = await draftOnboardingPlan(ctxWithPosthog);
    expect(plan).toBeDefined();
  });
});

describe("OnboardingPlan schema", () => {
  it("accepts a valid plan", () => {
    const result = OnboardingPlan.safeParse(FIXED_PLAN);
    expect(result.success).toBe(true);
  });

  it("rejects a plan with no tips", () => {
    const result = OnboardingPlan.safeParse({ ...FIXED_PLAN, tips: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a plan with more than 3 tips", () => {
    const result = OnboardingPlan.safeParse({
      ...FIXED_PLAN,
      tips: ["a", "b", "c", "d"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a plan missing featureToActivate", () => {
    const { featureToActivate: _omitted, ...withoutFeature } = FIXED_PLAN;
    const result = OnboardingPlan.safeParse(withoutFeature);
    expect(result.success).toBe(false);
  });
});
