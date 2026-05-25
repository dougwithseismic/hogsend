import { days, hours } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const conversionAbandonedCheckout = defineJourney({
  meta: {
    id: "conversion-abandoned-checkout",
    name: "Conversion — Abandoned Checkout",
    enabled: true,
    trigger: { event: Events.CHECKOUT_ABANDONED },
    entryLimit: "once_per_period",
    entryPeriod: days(3),
    suppress: hours(4),
    exitOn: [
      { event: Events.SUBSCRIPTION_CREATED },
      { event: Events.CHECKOUT_COMPLETED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2), label: "initial-followup" });

    const { found: hasCompleted } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.CHECKOUT_COMPLETED,
      within: hours(2),
    });
    if (hasCompleted) {
      return;
    }

    await sendEmail({
      to: user.email,
      userId: user.id,
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Need help with anything?",
      journeyName: user.journeyName,
      props: { daysLeft: 0 },
    });

    await ctx.sleep({ duration: days(1), label: "second-followup" });

    const { found: hasCompletedLater } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.CHECKOUT_COMPLETED,
      within: hours(26),
    });
    if (!hasCompletedLater) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "Still thinking it over? Here's a little incentive",
        journeyName: user.journeyName,
      });
    }
  },
});
