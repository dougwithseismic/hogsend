/**
 * End-to-end test for the AI agent integration.
 *
 * This test actually calls the Anthropic API (requires ANTHROPIC_API_KEY)
 * and validates the full chain: context → agent → validated response.
 *
 * Run with: ANTHROPIC_API_KEY=... pnpm --filter @hogsend/api test e2e-ai-agent
 */

import type { JourneyContext, JourneyUser } from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import {
  draftOnboardingPlan,
  OnboardingPlan,
} from "../agents/onboarding-concierge.js";
import {
  decideNextBestAction,
  ReengagementDecision,
} from "../agents/reengagement-strategist.js";
import type { UserContext } from "../lib/user-context.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "AI agent end-to-end (requires ANTHROPIC_API_KEY)",
  () => {
    it("draftOnboardingPlan returns a valid OnboardingPlan from Claude", async () => {
      const mockContext: UserContext = {
        contact: {
          id: "test-user-e2e",
          email: "test@example.com",
          properties: {
            company: "Acme Corp",
            role: "Developer",
            plan: "starter",
          },
        },
        events: [
          {
            event: "user.created",
            properties: { source: "website" },
            occurredAt: new Date().toISOString(),
          },
          {
            event: "page.viewed",
            properties: { path: "/docs/getting-started" },
            occurredAt: new Date(Date.now() - 60000).toISOString(),
          },
        ],
        email: {
          everOpened: false,
          everClicked: false,
        },
        posthog: {
          $initial_referrer: "https://google.com",
          $browser: "Chrome",
        },
      };

      const plan = await draftOnboardingPlan(mockContext);

      // Validate against the Zod schema
      const parsed = OnboardingPlan.safeParse(plan);
      expect(parsed.success).toBe(true);

      // Check structure
      expect(plan).toHaveProperty("subject");
      expect(plan).toHaveProperty("body");
      expect(plan).toHaveProperty("tips");
      expect(plan).toHaveProperty("featureToActivate");

      // Check constraints
      expect(typeof plan.subject).toBe("string");
      expect(plan.subject.length).toBeGreaterThan(0);
      expect(plan.subject.length).toBeLessThanOrEqual(100); // reasonable subject

      expect(typeof plan.body).toBe("string");
      expect(plan.body.length).toBeGreaterThan(0);

      expect(Array.isArray(plan.tips)).toBe(true);
      expect(plan.tips.length).toBeGreaterThanOrEqual(1);
      expect(plan.tips.length).toBeLessThanOrEqual(3);

      expect(typeof plan.featureToActivate).toBe("string");
      expect(plan.featureToActivate.length).toBeGreaterThan(0);

      console.log("\n✅ AI Agent Response:");
      console.log(JSON.stringify(plan, null, 2));
    }, 30000); // 30s timeout for API call

    it("decideNextBestAction returns a valid decision via real tool calls", async () => {
      // A user who clearly engaged before, then drifted — the agent should
      // pull this history through its tools before deciding.
      const recentEvents = [
        {
          event: "feature.used",
          properties: { feature: "journey-builder" },
          occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        },
        {
          event: "key.action",
          properties: { action: "published-journey" },
          occurredAt: new Date(Date.now() - 38 * 86_400_000).toISOString(),
        },
      ];

      // Minimal JourneyUser — a plain interface, build it for real.
      const user: JourneyUser = {
        id: "user-e2e-reengage",
        email: "drifted@example.com",
        properties: { plan: "pro" },
        stateId: "state-e2e",
        journeyId: "ai-reengagement",
        journeyName: "AI Re-engagement",
      };

      // Stub only the ctx surface the agent's tools touch: ctx.history.
      const ctx = {
        history: {
          hasEvent: async ({ event }: { event: string }) => {
            const count = recentEvents.filter((e) => e.event === event).length;
            return { found: count > 0, count };
          },
          events: async ({ limit }: { limit?: number }) =>
            recentEvents.slice(0, limit ?? recentEvents.length),
        },
      } as unknown as JourneyContext;

      const decision = await decideNextBestAction(user, ctx);

      // The Zod schema is the contract — action enum + reason string.
      const parsed = ReengagementDecision.safeParse(decision);
      expect(parsed.success).toBe(true);
      expect(typeof decision.reason).toBe("string");
      expect(decision.reason.length).toBeGreaterThan(0);

      console.log("\n✅ Re-engagement decision:");
      console.log(JSON.stringify(decision, null, 2));
    }, 120000); // 120s — Opus 4.8 tool-calling loop makes several sequential round trips
  },
);
