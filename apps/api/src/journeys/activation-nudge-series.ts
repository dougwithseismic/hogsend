import { defineJourney } from "./define-journey.js";

export const activationNudgeSeries = defineJourney({
  meta: {
    id: "activation-nudge-series",
    name: "Activation — Behavioral Nudges",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppressHours: 12,
    exitOn: [{ event: "user.deleted" }, { event: "user.activated" }],
  },

  run: async (user, ctx) => {
    await ctx.sleepFor("48h", "wait:initial-nudge");

    const hasUsedFeature = await ctx.hasEvent(user.id, "feature.used", {
      withinHours: 48,
    });
    if (!hasUsedFeature) {
      await ctx.sendEmail(user, {
        template: "activation-nudge",
        subject: "You haven't tried the key feature yet",
      });
    }

    await ctx.sleepFor("24h", "wait:setup-check");

    const hasCompletedSetup = await ctx.hasEvent(user.id, "setup.completed", {
      withinHours: 72,
    });
    if (!hasCompletedSetup) {
      await ctx.sendEmail(user, {
        template: "activation-quickstart",
        subject: "Need help getting set up?",
      });
    }

    await ctx.sleepFor("48h", "wait:first-value");

    const hasFirstValue = await ctx.hasEvent(user.id, "value.delivered");
    if (hasFirstValue) {
      await ctx.sendEmail(user, {
        template: "activation-feature-highlight",
        subject: "Nice work — here's what to try next",
      });
    }

    await ctx.sleepFor("48h", "wait:community");

    await ctx.sendEmail(user, {
      template: "activation-community",
      subject: "Join the community",
    });
  },
});
