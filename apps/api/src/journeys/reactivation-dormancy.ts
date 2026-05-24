import { defineJourney } from "./define-journey.js";

export const reactivationDormancy = defineJourney({
  meta: {
    id: "reactivation-dormancy",
    name: "Reactivation — Dormancy Sequence",
    enabled: true,
    trigger: { event: "user.dormancy_detected" },
    entryLimit: "once_per_period",
    entryPeriodHours: 1440,
    suppressHours: 48,
    exitOn: [
      { event: "user.deleted" },
      { event: "session.completed" },
      { event: "feature.used" },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sendEmail(user, {
      template: "reactivation-checkin",
      subject: "We haven't seen you in a while",
      props: { daysSinceActive: 14 },
    });

    await ctx.sleepFor("168h", "wait:day-21");

    await ctx.sendEmail(user, {
      template: "reactivation-checkin",
      subject: "Your data is still here — pick up where you left off",
      props: { daysSinceActive: 21 },
    });

    await ctx.sleepFor("216h", "wait:day-30");

    const isPaid = await ctx.checkProperty("context", "plan", "eq", "paid");
    if (isPaid) {
      await ctx.sendEmail(user, {
        template: "conversion-winback-offer",
        subject: "We'd hate to see you go — here's an option",
      });
    } else {
      await ctx.sendEmail(user, {
        template: "conversion-winback-offer",
        subject: "See what you've been missing",
      });
    }

    await ctx.sleepFor("360h", "wait:day-45");

    await ctx.sendEmail(user, {
      template: "reactivation-final-nudge",
      subject: "One last note from us",
    });

    await ctx.fireEvent(user.id, "user.suppressed", {
      reason: "dormancy_sequence_completed",
      suppressedAt: new Date().toISOString(),
    });
  },
});
