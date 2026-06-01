import { hours } from "@hogsend/core";
import { defineJourney } from "@hogsend/engine";
import { Events } from "./constants/index.js";

export const testOnboarding = defineJourney({
  meta: {
    id: "test-onboarding",
    name: "Test — Onboarding Flow",
    enabled: true,
    trigger: { event: Events.TEST_SIGNUP },
    entryLimit: "unlimited",
    suppress: hours(0),
  },

  run: async (user, ctx) => {
    await ctx.trigger({
      event: Events.JOURNEY_WELCOME_FIRED,
      userId: user.id,
      properties: { step: "welcome" },
    });

    const isPro = user.properties.plan === "pro";

    if (isPro) {
      await ctx.trigger({
        event: Events.JOURNEY_PRO_PATH,
        userId: user.id,
        properties: { step: "pro_branch" },
      });
    } else {
      await ctx.trigger({
        event: Events.JOURNEY_FREE_PATH,
        userId: user.id,
        properties: { step: "free_branch" },
      });
    }

    await ctx.trigger({
      event: Events.JOURNEY_COMPLETED,
      userId: user.id,
      properties: { step: "done" },
    });
  },
});
