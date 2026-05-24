import { defineJourney } from "./define-journey.js";

export const referralInvite = defineJourney({
  meta: {
    id: "referral-invite",
    name: "Referral — Post-Achievement Invite",
    enabled: true,
    trigger: { event: "milestone.reached" },
    entryLimit: "once_per_period",
    entryPeriodHours: 168,
    suppressHours: 48,
    exitOn: [{ event: "user.deleted" }],
  },

  run: async (user, ctx) => {
    await ctx.sleepFor("2h", "wait:post-achievement");

    const isActive30d = await ctx.hasEvent(user.id, "session.completed", {
      withinHours: 720,
    });
    if (!isActive30d) {
      return;
    }

    await ctx.sendEmail(user, {
      template: "retention-achievement",
      subject: "Share the love — invite a friend",
      props: {
        ctaText: "Invite a Friend",
      },
    });
  },
});
