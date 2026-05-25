import { days } from "@hogsend/core";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const churnPrevention = defineJourney({
  meta: {
    id: "churn-prevention",
    name: "Churn — Payment Recovery & Prevention",
    enabled: true,
    trigger: { event: Events.PAYMENT_FAILED },
    entryLimit: "once_per_period",
    entryPeriodHours: 168,
    suppressHours: 4,
    exitOn: [
      { event: Events.PAYMENT_SUCCEEDED },
      { event: Events.SUBSCRIPTION_CANCELLED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.email.send(user, {
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Your payment didn't go through",
    });

    await ctx.sleep({ duration: days(1), label: "first-retry" });

    const { found: hasRetried } = await ctx.event.check({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      withinHours: 24,
    });
    if (hasRetried) {
      return;
    }

    await ctx.email.send(user, {
      template: Templates.CHURN_PAYMENT_FAILED,
      subject: "Reminder: please update your payment method",
      props: { gracePeriodDays: 2 },
    });

    await ctx.sleep({ duration: days(2), label: "final-notice" });

    const { found: hasResolved } = await ctx.event.check({
      userId: user.id,
      event: Events.PAYMENT_SUCCEEDED,
      withinHours: 72,
    });
    if (!hasResolved) {
      await ctx.email.send(user, {
        template: Templates.CHURN_PAYMENT_FAILED,
        subject: "Final notice: your account will be downgraded tomorrow",
        props: { gracePeriodDays: 1 },
      });
    }
  },
});
