import { days } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
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
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: Templates.REACTIVATION_CHECKIN,
      subject: "We haven't seen you in a while",
      journeyName: user.journeyName,
      props: { daysSinceActive: 14 },
    });

    await ctx.sleep({ duration: days(7), label: "day-21" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      template: Templates.REACTIVATION_CHECKIN,
      subject: "Your data is still here — pick up where you left off",
      journeyName: user.journeyName,
      props: { daysSinceActive: 21 },
    });

    await ctx.sleep({ duration: days(9), label: "day-30" });

    const isPaid = user.properties.plan === "paid";
    if (isPaid) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "We'd hate to see you go — here's an option",
        journeyName: user.journeyName,
      });
    } else {
      await sendEmail({
        to: user.email,
        userId: user.id,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "See what you've been missing",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(15), label: "day-45" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      template: Templates.REACTIVATION_FINAL_NUDGE,
      subject: "One last note from us",
      journeyName: user.journeyName,
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
