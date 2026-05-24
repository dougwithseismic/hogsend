import { defineJourney } from "./define-journey.js";

export const testOnboarding = defineJourney({
  meta: {
    id: "test-onboarding",
    name: "Test — Onboarding Flow",
    enabled: true,
    trigger: { event: "test.signup" },
    entryLimit: "unlimited",
    suppressHours: 0,
  },

  run: async (user, ctx) => {
    await ctx.fireEvent(user.id, "journey.welcome_fired", { step: "welcome" });

    const isPro = await ctx.checkProperty("context", "plan", "eq", "pro");

    if (isPro) {
      await ctx.fireEvent(user.id, "journey.pro_path", {
        step: "pro_branch",
      });
    } else {
      await ctx.fireEvent(user.id, "journey.free_path", {
        step: "free_branch",
      });
    }

    await ctx.fireEvent(user.id, "journey.completed", { step: "done" });
  },
});
