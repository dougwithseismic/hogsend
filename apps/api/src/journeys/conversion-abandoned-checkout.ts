import { days, hours } from "@hogsend/core";
import { sendJourneyEmail } from "../lib/journey-email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const conversionAbandonedCheckout = defineJourney({
  meta: {
    id: "conversion-abandoned-checkout",
    name: "Conversion — Abandoned Checkout",
    enabled: true,
    trigger: { event: Events.CHECKOUT_ABANDONED },
    entryLimit: "once_per_period",
    entryPeriodHours: 72,
    suppressHours: 4,
    exitOn: [
      { event: Events.SUBSCRIPTION_CREATED },
      { event: Events.CHECKOUT_COMPLETED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2), label: "initial-followup" });

    const { found: hasCompleted } = await ctx.event.check({
      userId: user.id,
      event: Events.CHECKOUT_COMPLETED,
      withinHours: 2,
    });
    if (hasCompleted) {
      return;
    }

    await sendJourneyEmail(user, {
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Need help with anything?",
      props: { daysLeft: 0 },
    });

    await ctx.sleep({ duration: days(1), label: "second-followup" });

    const { found: hasCompletedLater } = await ctx.event.check({
      userId: user.id,
      event: Events.CHECKOUT_COMPLETED,
      withinHours: 26,
    });
    if (!hasCompletedLater) {
      await sendJourneyEmail(user, {
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "Still thinking it over? Here's a little incentive",
      });
    }
  },
});
