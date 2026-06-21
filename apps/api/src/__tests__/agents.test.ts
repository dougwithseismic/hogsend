/**
 * Unit tests for the AI agent modules.
 *
 * `ai` is mocked so these run offline with no API key. The mock returns a
 * fixed `object` that satisfies `OnboardingPlan`; the test asserts the agent
 * function unwraps and returns it correctly.
 *
 * Phase 3 tests cover `decideNextBestAction`: the tool-decision path and the
 * `suppress` branch (agent stays silent → no email sent).
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state for Phase 3.
// generateText mock simulates the model calling the `decide` tool by finding
// and invoking the tool's execute function directly.
// ---------------------------------------------------------------------------

/** Override per-test to control which decision the mock model makes. */
let mockDecideArgs:
  | { action: string; reason: string }
  | "skip" // skip = don't call decide at all (test fallback behaviour)
  | undefined;

const FIXED_PLAN = {
  subject: "Welcome — here's where to start",
  body: "Based on your setup, we think you'll get the most out of the journey builder.",
  tips: ["Define your first journey", "Connect your PostHog project"],
  featureToActivate: "the journey builder",
};

vi.mock("ai", () => ({
  generateObject: vi.fn().mockResolvedValue({ object: FIXED_PLAN }),

  generateText: vi
    .fn()
    .mockImplementation(
      async (opts: {
        tools?: Record<
          string,
          { execute?: (input: Record<string, unknown>) => Promise<unknown> }
        >;
      }) => {
        const decideTool = opts.tools?.decide;
        if (mockDecideArgs === "skip") {
          // Don't call decide — tests the fallback path.
        } else if (decideTool?.execute) {
          const args = mockDecideArgs ?? {
            action: "reengage_tip_a",
            reason: "User has not engaged recently.",
          };
          await decideTool.execute(args);
        }
        // Return a minimal object that satisfies the mock — test code uses
        // `as unknown` when asserting so the exact shape doesn't matter here.
        return {};
      },
    ),

  // The `tool` helper is an identity pass-through in tests — the real logic
  // is in the execute functions; no type transformation needed.
  tool: vi.fn().mockImplementation((defn: unknown) => defn),

  // stepCountIs is used in the agent; return a no-op stop condition.
  stepCountIs: vi.fn().mockReturnValue(() => false),
}));

// Mock `@ai-sdk/anthropic` so `createAnthropic()` doesn't need a real key.
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({
    modelId,
    provider: "anthropic",
  })),
}));

// Import agents after mocks are registered.
const { draftOnboardingPlan, OnboardingPlan } = await import(
  "../agents/onboarding-concierge.js"
);
const { decideNextBestAction, ReengagementDecision, ReengagementAction } =
  await import("../agents/reengagement-strategist.js");

// ---------------------------------------------------------------------------
// Minimal stubs
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

/** Minimal JourneyUser stub. */
const minimalUser = {
  id: "user-123",
  email: "ada@example.com",
  stateId: "state-456",
  journeyId: "ai-reengagement",
  journeyName: "AI Re-engagement",
  properties: { plan: "free" } as Record<
    string,
    string | number | boolean | null
  >,
  triggeredByEvent: "user.dormant_30d",
  triggeredAt: new Date().toISOString(),
};

/** Minimal JourneyContext stub — tools only use ctx.history. */
const minimalCtx = {
  history: {
    hasEvent: vi.fn().mockResolvedValue({ found: false, count: 0 }),
    events: vi.fn().mockResolvedValue([]),
    journey: vi.fn().mockResolvedValue({ completed: false }),
    email: vi.fn().mockResolvedValue({ sent: false }),
  },
  checkpoint: vi.fn().mockResolvedValue(undefined),
  sleep: vi.fn().mockResolvedValue({ sleptAt: "", resumedAt: "" }),
  guard: { isSubscribed: vi.fn().mockResolvedValue(true) },
};

// ---------------------------------------------------------------------------
// Phase 2: draftOnboardingPlan tests
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

// ---------------------------------------------------------------------------
// Phase 3: decideNextBestAction tests
// ---------------------------------------------------------------------------

describe("decideNextBestAction()", () => {
  it("returns a decision that satisfies the ReengagementDecision schema", async () => {
    mockDecideArgs = undefined; // default → reengage_tip_a
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    const result = ReengagementDecision.safeParse(decision);
    expect(result.success).toBe(true);
  });

  it("returns reengage_tip_a when the mock agent decides tip A", async () => {
    mockDecideArgs = undefined; // default
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(decision.action).toBe("reengage_tip_a");
    expect(typeof decision.reason).toBe("string");
  });

  it("returns reengage_tip_b when the mock agent decides tip B", async () => {
    mockDecideArgs = {
      action: "reengage_tip_b",
      reason: "Power user who hasn't logged in recently.",
    };
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(decision.action).toBe("reengage_tip_b");
  });

  it("returns reengage_webinar when the mock agent decides webinar", async () => {
    mockDecideArgs = {
      action: "reengage_webinar",
      reason: "User never completed onboarding.",
    };
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(decision.action).toBe("reengage_webinar");
  });

  it("returns suppress when the mock agent decides to stay silent", async () => {
    mockDecideArgs = {
      action: "suppress",
      reason: "User re-engaged via organic channel yesterday.",
    };
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toBe(
      "User re-engaged via organic channel yesterday.",
    );
  });

  it("falls back to suppress when the agent never calls decide", async () => {
    mockDecideArgs = "skip";
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(decision.action).toBe("suppress");
    expect(decision.reason).toContain("Agent did not call decide tool");
  });

  it("reason is always a non-empty string", async () => {
    mockDecideArgs = undefined;
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(typeof decision.reason).toBe("string");
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("action is always a valid ReengagementAction value", async () => {
    mockDecideArgs = undefined;
    const decision = await decideNextBestAction(
      minimalUser,
      minimalCtx as never,
    );
    expect(ReengagementAction.safeParse(decision.action).success).toBe(true);
  });
});

describe("ReengagementDecision schema", () => {
  it("accepts all valid action values", () => {
    const actions = [
      "reengage_tip_a",
      "reengage_tip_b",
      "reengage_webinar",
      "suppress",
    ] as const;
    for (const action of actions) {
      const result = ReengagementDecision.safeParse({
        action,
        reason: "test reason",
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown action", () => {
    const result = ReengagementDecision.safeParse({
      action: "send_sms",
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decision with no reason", () => {
    const result = ReengagementDecision.safeParse({ action: "suppress" });
    expect(result.success).toBe(false);
  });
});

describe("ReengagementAction schema", () => {
  it("accepts suppress", () => {
    expect(ReengagementAction.safeParse("suppress").success).toBe(true);
  });

  it("accepts all send actions", () => {
    expect(ReengagementAction.safeParse("reengage_tip_a").success).toBe(true);
    expect(ReengagementAction.safeParse("reengage_tip_b").success).toBe(true);
    expect(ReengagementAction.safeParse("reengage_webinar").success).toBe(true);
  });

  it("rejects an unknown value", () => {
    expect(ReengagementAction.safeParse("call_phone").success).toBe(false);
  });
});
