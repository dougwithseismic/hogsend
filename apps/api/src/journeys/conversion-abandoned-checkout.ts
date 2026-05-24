import { defineJourney } from "./define-journey.js";

export const conversionAbandonedCheckout = defineJourney({
  meta: {
    id: "conversion-abandoned-checkout",
    name: "Conversion — Abandoned Checkout",
    enabled: true,
    trigger: { event: "checkout.abandoned" },
    entryLimit: "once_per_period",
    entryPeriodHours: 72,
    suppressHours: 4,
    exitOn: [
      { event: "subscription.created" },
      { event: "checkout.completed" },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleepFor("2h", "wait:initial-followup");

    const hasCompleted = await ctx.hasEvent(user.id, "checkout.completed", {
      withinHours: 2,
    });
    if (hasCompleted) {
      return;
    }

    await ctx.sendEmail(user, {
      template: "conversion-trial-expiring",
      subject: "Need help with anything?",
      props: {
        daysLeft: 0,
      },
    });

    await ctx.sleepFor("24h", "wait:second-followup");

    const hasCompletedLater = await ctx.hasEvent(
      user.id,
      "checkout.completed",
      { withinHours: 26 },
    );
    if (!hasCompletedLater) {
      await ctx.sendEmail(user, {
        template: "conversion-winback-offer",
        subject: "Still thinking it over? Here's a little incentive",
      });
    }
  },
});
