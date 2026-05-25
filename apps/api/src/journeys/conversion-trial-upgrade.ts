import { days } from "@hogsend/core";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const conversionTrialUpgrade = defineJourney({
  meta: {
    id: "conversion-trial-upgrade",
    name: "Conversion — Trial to Paid",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    suppressHours: 24,
    exitOn: [
      { event: Events.SUBSCRIPTION_CREATED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3), label: "usage-milestone" });

    const { found: hasUsageMilestone } = await ctx.event.check({
      userId: user.id,
      event: Events.USAGE_MILESTONE_REACHED,
    });
    if (hasUsageMilestone) {
      await ctx.email.send(user, {
        template: Templates.CONVERSION_USAGE_MILESTONE,
        subject: "You're on a roll — here's what Pro unlocks",
      });
    }

    await ctx.sleep({ duration: days(4), label: "trial-midpoint" });

    const { found: hasPaidFeatureAttempt } = await ctx.event.check({
      userId: user.id,
      event: Events.PAID_FEATURE_ATTEMPTED,
    });
    if (hasPaidFeatureAttempt) {
      await ctx.email.send(user, {
        template: Templates.CONVERSION_USAGE_MILESTONE,
        subject: "You just hit a limit — upgrade to keep going",
      });
    }

    await ctx.sleep({ duration: days(3), label: "trial-ending" });

    await ctx.email.send(user, {
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Your trial ends in 3 days — don't lose your progress",
    });

    await ctx.sleep({ duration: days(2), label: "trial-final" });

    await ctx.email.send(user, {
      template: Templates.CONVERSION_TRIAL_EXPIRING,
      subject: "Last day of your trial",
      props: { daysLeft: 1 },
    });

    await ctx.sleep({ duration: days(2), label: "post-expiry" });

    const { found: hasSubscription } = await ctx.event.check({
      userId: user.id,
      event: Events.SUBSCRIPTION_CREATED,
    });
    if (!hasSubscription) {
      await ctx.email.send(user, {
        template: Templates.CONVERSION_WINBACK_OFFER,
        subject: "We'd love to have you back — here's 20% off",
      });
    }
  },
});
