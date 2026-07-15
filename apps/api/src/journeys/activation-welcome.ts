import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const activationWelcome = defineJourney({
  meta: {
    id: "activation-welcome",
    tier: "activation",
    name: "Activation — Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome to Hogsend — let's get you set up",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    const { found: hasUsedFeature } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
    });

    if (hasUsedFeature) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_ADVANCED,
        subject: "Nice work — here's what to try next",
        journeyName: user.journeyName,
      });
    } else {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_NUDGE,
        subject: "You haven't tried the key feature yet",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(2), label: "pre-community" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_COMMUNITY,
      subject: "Join the community",
      journeyName: user.journeyName,
    });
  },
});
