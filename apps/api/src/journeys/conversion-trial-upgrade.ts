import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const conversionTrialUpgrade = defineJourney({
  meta: {
    id: "conversion-trial-upgrade",
    name: "Conversion — Trial to Paid",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [
      { event: Events.SUBSCRIPTION_CREATED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3), label: "usage-milestone" });

    const { found: hasUsageMilestone } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.USAGE_MILESTONE_REACHED,
    });
    if (hasUsageMilestone) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CONVERSION_USAGE_MILESTONE,
        subject: "You're on a roll — here's what Pro unlocks",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(4), label: "trial-midpoint" });

    const { found: hasPaidFeatureAttempt } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.PAID_FEATURE_ATTEMPTED,
    });
    if (hasPaidFeatureAttempt) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CONVERSION_USAGE_MILESTONE,
        subject: "You just hit a limit — upgrade to keep going",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(3), label: "trial-ending" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Your trial ends in 3 days — don't lose your progress",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(2), label: "trial-final" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Last day of your trial",
      journeyName: user.journeyName,
      props: { daysLeft: 1 },
    });

    await ctx.sleep({ duration: days(2), label: "post-expiry" });

    const { found: hasSubscription } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.SUBSCRIPTION_CREATED,
    });
    if (!hasSubscription) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "We'd love to have you back — here's 20% off",
        journeyName: user.journeyName,
      });
    }
  },
});
