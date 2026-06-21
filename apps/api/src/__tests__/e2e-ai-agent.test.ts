/**
 * End-to-end test for the AI agent integration.
 *
 * This test actually calls the Anthropic API (requires ANTHROPIC_API_KEY)
 * and validates the full chain: context → agent → validated response.
 *
 * Run with: ANTHROPIC_API_KEY=... pnpm --filter @hogsend/api test e2e-ai-agent
 */

import { describe, expect, it } from "vitest";
import {
  draftOnboardingPlan,
  OnboardingPlan,
} from "../agents/onboarding-concierge.js";
import type { UserContext } from "../lib/user-context.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)(
  "AI agent end-to-end (requires ANTHROPIC_API_KEY)",
  () => {
    it("draftOnboardingPlan returns a valid OnboardingPlan from Claude", async () => {
      const mockContext: UserContext = {
        contact: {
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
  },
);
