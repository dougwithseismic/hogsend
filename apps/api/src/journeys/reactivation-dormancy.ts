import { days } from "@hogsend/core";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const reactivationDormancy = defineJourney({
  meta: {
    id: "reactivation-dormancy",
    name: "Reactivation — Dormancy Sequence",
    enabled: true,
    trigger: { event: Events.USER_DORMANCY_DETECTED },
    entryLimit: "once_per_period",
    entryPeriodHours: 1440,
    suppressHours: 48,
    exitOn: [
      { event: Events.USER_DELETED },
      { event: Events.SESSION_COMPLETED },
      { event: Events.FEATURE_USED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.email.send(user, {
      template: Templates.REACTIVATION_CHECKIN,
      subject: "We haven't seen you in a while",
      props: { daysSinceActive: 14 },
    });

    await ctx.sleep({ duration: days(7), label: "day-21" });

    await ctx.email.send(user, {
      template: Templates.REACTIVATION_CHECKIN,
      subject: "Your data is still here — pick up where you left off",
      props: { daysSinceActive: 21 },
    });

    await ctx.sleep({ duration: days(9), label: "day-30" });

    const { matched: isPaid } = await ctx.property.check({
      source: "context",
      property: "plan",
      operator: "eq",
      value: "paid",
    });
    if (isPaid) {
      await ctx.email.send(user, {
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "We'd hate to see you go — here's an option",
      });
    } else {
      await ctx.email.send(user, {
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "See what you've been missing",
      });
    }

    await ctx.sleep({ duration: days(15), label: "day-45" });

    await ctx.email.send(user, {
      template: Templates.REACTIVATION_FINAL_NUDGE,
      subject: "One last note from us",
    });

    await ctx.event.fire({
      userId: user.id,
      event: Events.USER_SUPPRESSED,
      properties: {
        reason: "dormancy_sequence_completed",
        suppressedAt: new Date().toISOString(),
      },
    });
  },
});
