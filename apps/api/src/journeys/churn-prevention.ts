import { defineJourney } from "./define-journey.js";

export const churnPrevention = defineJourney({
  meta: {
    id: "churn-prevention",
    name: "Churn — Payment Recovery & Prevention",
    enabled: true,
    trigger: { event: "payment.failed" },
    entryLimit: "once_per_period",
    entryPeriodHours: 168,
    suppressHours: 4,
    exitOn: [
      { event: "payment.succeeded" },
      { event: "subscription.cancelled" },
      { event: "user.deleted" },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sendEmail(user, {
      template: "churn-payment-failed",
      subject: "Your payment didn't go through",
    });

    await ctx.sleepFor("24h", "wait:first-retry");

    const hasRetried = await ctx.hasEvent(user.id, "payment.succeeded", {
      withinHours: 24,
    });
    if (hasRetried) {
      return;
    }

    await ctx.sendEmail(user, {
      template: "churn-payment-failed",
      subject: "Reminder: please update your payment method",
      props: { gracePeriodDays: 2 },
    });

    await ctx.sleepFor("48h", "wait:final-notice");

    const hasResolved = await ctx.hasEvent(user.id, "payment.succeeded", {
      withinHours: 72,
    });
    if (!hasResolved) {
      await ctx.sendEmail(user, {
        template: "churn-payment-failed",
        subject: "Final notice: your account will be downgraded tomorrow",
        props: { gracePeriodDays: 1 },
      });
    }
  },
});
