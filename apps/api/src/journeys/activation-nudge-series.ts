import { days } from "@hogsend/core";
import { sendJourneyEmail } from "../lib/journey-email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const activationNudgeSeries = defineJourney({
  meta: {
    id: "activation-nudge-series",
    name: "Activation — Behavioral Nudges",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppressHours: 12,
    exitOn: [{ event: Events.USER_DELETED }, { event: Events.USER_ACTIVATED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(2), label: "initial-nudge" });

    const { found: hasUsedFeature } = await ctx.event.check({
      userId: user.id,
      event: Events.FEATURE_USED,
      withinHours: 48,
    });
    if (!hasUsedFeature) {
      await sendJourneyEmail(user, {
        template: Templates.ACTIVATION_NUDGE_SERIES,
        subject: "You haven't tried the key feature yet",
      });
    }

    await ctx.sleep({ duration: days(1), label: "setup-check" });

    const { found: hasCompletedSetup } = await ctx.event.check({
      userId: user.id,
      event: Events.SETUP_COMPLETED,
      withinHours: 72,
    });
    if (!hasCompletedSetup) {
      await sendJourneyEmail(user, {
        template: Templates.ACTIVATION_QUICKSTART,
        subject: "Need help getting set up?",
      });
    }

    await ctx.sleep({ duration: days(2), label: "first-value" });

    const { found: hasFirstValue } = await ctx.event.check({
      userId: user.id,
      event: Events.VALUE_DELIVERED,
    });
    if (hasFirstValue) {
      await sendJourneyEmail(user, {
        template: Templates.ACTIVATION_FEATURE_HIGHLIGHT,
        subject: "Nice work — here's what to try next",
      });
    }

    await ctx.sleep({ duration: days(2), label: "community" });

    await sendJourneyEmail(user, {
      template: Templates.ACTIVATION_COMMUNITY_ALT,
      subject: "Join the community",
    });
  },
});
