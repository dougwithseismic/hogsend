import { defineJourney } from "./define-journey.js";

export const activationWelcome = defineJourney({
  meta: {
    id: "activation-welcome",
    name: "Activation — Welcome Series",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppressHours: 12,
    exitOn: [{ event: "user.deleted" }],
  },

  run: async (user, ctx) => {
    await ctx.sendEmail(user, {
      template: "activation/welcome",
      subject: "Welcome to Hogsend — let's get you set up",
    });

    await ctx.sleepFor("48h", "wait:post_welcome");

    const hasUsedFeature = await ctx.hasEvent(user.id, "feature.used");

    if (hasUsedFeature) {
      await ctx.sendEmail(user, {
        template: "activation/advanced",
        subject: "Nice work — here's what to try next",
      });
    } else {
      await ctx.sendEmail(user, {
        template: "activation/nudge",
        subject: "You haven't tried the key feature yet",
      });
    }

    await ctx.sleepFor("48h", "wait:pre_community");

    await ctx.sendEmail(user, {
      template: "activation/community",
      subject: "Join the community",
    });
  },
});
