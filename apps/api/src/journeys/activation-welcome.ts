import { days } from "@hogsend/core";
import { sendJourneyEmail } from "../lib/journey-email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const activationWelcome = defineJourney({
  meta: {
    id: "activation-welcome",
    name: "Activation — Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppressHours: 12,
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendJourneyEmail(user, {
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome to Hogsend — let's get you set up",
    });

    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    const { found: hasUsedFeature } = await ctx.event.check({
      userId: user.id,
      event: Events.FEATURE_USED,
    });

    if (hasUsedFeature) {
      await sendJourneyEmail(user, {
        template: Templates.ACTIVATION_ADVANCED,
        subject: "Nice work — here's what to try next",
      });
    } else {
      await sendJourneyEmail(user, {
        template: Templates.ACTIVATION_NUDGE,
        subject: "You haven't tried the key feature yet",
      });
    }

    await ctx.sleep({ duration: days(2), label: "pre-community" });

    await sendJourneyEmail(user, {
      template: Templates.ACTIVATION_COMMUNITY,
      subject: "Join the community",
    });
  },
});
