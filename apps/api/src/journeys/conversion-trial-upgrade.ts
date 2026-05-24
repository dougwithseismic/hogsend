import { defineJourney } from "./define-journey.js";

export const conversionTrialUpgrade = defineJourney({
  meta: {
    id: "conversion-trial-upgrade",
    name: "Conversion — Trial to Paid",
    enabled: true,
    trigger: { event: "trial.started" },
    entryLimit: "once",
    suppressHours: 24,
    exitOn: [{ event: "subscription.created" }, { event: "user.deleted" }],
  },

  run: async (user, ctx) => {
    await ctx.sleepFor("72h", "wait:usage-milestone");

    const hasUsageMilestone = await ctx.hasEvent(
      user.id,
      "usage.milestone_reached",
    );
    if (hasUsageMilestone) {
      await ctx.sendEmail(user, {
        template: "conversion-usage-milestone",
        subject: "You're on a roll — here's what Pro unlocks",
      });
    }

    await ctx.sleepFor("96h", "wait:trial-midpoint");

    const hasPaidFeatureAttempt = await ctx.hasEvent(
      user.id,
      "paid_feature.attempted",
    );
    if (hasPaidFeatureAttempt) {
      await ctx.sendEmail(user, {
        template: "conversion-usage-milestone",
        subject: "You just hit a limit — upgrade to keep going",
      });
    }

    await ctx.sleepFor("72h", "wait:trial-ending");

    await ctx.sendEmail(user, {
      template: "conversion-trial-expiring",
      subject: "Your trial ends in 3 days — don't lose your progress",
    });

    await ctx.sleepFor("48h", "wait:trial-final");

    await ctx.sendEmail(user, {
      template: "conversion-trial-expiring",
      subject: "Last day of your trial",
      props: { daysLeft: 1 },
    });

    await ctx.sleepFor("48h", "wait:post-expiry");

    const hasSubscription = await ctx.hasEvent(user.id, "subscription.created");
    if (!hasSubscription) {
      await ctx.sendEmail(user, {
        template: "conversion-winback-offer",
        subject: "We'd love to have you back — here's 20% off",
      });
    }
  },
});
