import { defineJourney } from "./define-journey.js";

export const retentionMilestone = defineJourney({
  meta: {
    id: "retention-milestone",
    name: "Retention — Milestone Celebration",
    enabled: true,
    trigger: { event: "milestone.reached" },
    entryLimit: "unlimited",
    suppressHours: 24,
    exitOn: [{ event: "user.deleted" }],
  },

  run: async (user, ctx) => {
    await ctx.sendEmail(user, {
      template: "retention-achievement",
      subject: "Congratulations on your achievement!",
    });

    await ctx.sleepFor("24h", "wait:post-milestone");

    await ctx.sendEmail(user, {
      template: "activation-community",
      subject: "Share your achievement with the community",
    });
  },
});
