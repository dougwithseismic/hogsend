import { Events } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const testOnboarding = defineJourney({
  meta: {
    id: "test-onboarding",
    name: "Test — Onboarding Flow",
    enabled: true,
    trigger: { event: Events.TEST_SIGNUP },
    entryLimit: "unlimited",
    suppressHours: 0,
  },

  run: async (user, ctx) => {
    await ctx.event.fire({
      userId: user.id,
      event: Events.JOURNEY_WELCOME_FIRED,
      properties: { step: "welcome" },
    });

    const isPro = user.properties.plan === "pro";

    if (isPro) {
      await ctx.event.fire({
        userId: user.id,
        event: Events.JOURNEY_PRO_PATH,
        properties: { step: "pro_branch" },
      });
    } else {
      await ctx.event.fire({
        userId: user.id,
        event: Events.JOURNEY_FREE_PATH,
        properties: { step: "free_branch" },
      });
    }

    await ctx.event.fire({
      userId: user.id,
      event: Events.JOURNEY_COMPLETED,
      properties: { step: "done" },
    });
  },
});
