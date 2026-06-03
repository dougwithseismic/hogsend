import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { bucketLeft, Events, Templates } from "./constants/index.js";

export const reactivationDormancy = defineJourney({
  meta: {
    id: "reactivation-dormancy",
    name: "Reactivation — Dormancy Sequence",
    enabled: true,
    trigger: { event: Events.USER_DORMANCY_DETECTED },
    entryLimit: "once_per_period",
    entryPeriod: days(60),
    suppress: days(2),
    exitOn: [
      { event: Events.USER_DELETED },
      { event: Events.SESSION_COMPLETED },
      { event: Events.FEATURE_USED },
      // Bucket → journey composition (Section 7): when the user leaves the
      // `went-dormant` bucket they have become active again, so auto-exit the
      // winback sequence. `bucketLeft` is the id-validated alias helper, so a
      // typo here is a compile error. This proves the end-to-end bucket-leave →
      // `exitOn` path through `ingestEvent`'s `checkExits`.
      { event: bucketLeft("went-dormant") },
    ],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.REACTIVATION_CHECKIN,
      subject: "We haven't seen you in a while",
      journeyName: user.journeyName,
      props: { daysSinceActive: 14 },
    });

    await ctx.sleep({ duration: days(7), label: "day-21" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
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
        journeyStateId: user.stateId,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "We'd hate to see you go — here's an option",
        journeyName: user.journeyName,
      });
    } else {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "See what you've been missing",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(15), label: "day-45" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.REACTIVATION_FINAL_NUDGE,
      subject: "One last note from us",
      journeyName: user.journeyName,
    });

    await ctx.trigger({
      event: Events.USER_SUPPRESSED,
      userId: user.id,
      properties: {
        reason: "dormancy_sequence_completed",
        suppressedAt: new Date().toISOString(),
      },
    });
  },
});
