import { hours } from "@hogsend/core";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const referralInvite = defineJourney({
  meta: {
    id: "referral-invite",
    name: "Referral — Post-Achievement Invite",
    enabled: true,
    trigger: { event: Events.MILESTONE_REACHED },
    entryLimit: "once_per_period",
    entryPeriodHours: 168,
    suppressHours: 48,
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2), label: "post-achievement" });

    const { found: isActive30d } = await ctx.event.check({
      userId: user.id,
      event: Events.SESSION_COMPLETED,
      withinHours: 720,
    });
    if (!isActive30d) {
      return;
    }

    await ctx.email.send(user, {
      template: Templates.RETENTION_ACHIEVEMENT,
      subject: "Share the love — invite a friend",
      props: { ctaText: "Invite a Friend" },
    });
  },
});
