import { days, hours } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const activationNudgeSeries = defineJourney({
  meta: {
    id: "activation-nudge-series",
    name: "Activation — Behavioral Nudges",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.USER_DELETED }, { event: Events.USER_ACTIVATED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(2), label: "initial-nudge" });

    const { found: hasUsedFeature } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
      within: days(2),
    });
    if (!hasUsedFeature) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_NUDGE_SERIES,
        subject: "You haven't tried the key feature yet",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(1), label: "setup-check" });

    const { found: hasCompletedSetup } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.SETUP_COMPLETED,
      within: days(3),
    });
    if (!hasCompletedSetup) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_QUICKSTART,
        subject: "Need help getting set up?",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(2), label: "first-value" });

    const { found: hasFirstValue } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.VALUE_DELIVERED,
    });
    if (hasFirstValue) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_FEATURE_HIGHLIGHT,
        subject: "Nice work — here's what to try next",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(2), label: "community" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_COMMUNITY_ALT,
      subject: "Join the community",
      journeyName: user.journeyName,
    });
  },
});
