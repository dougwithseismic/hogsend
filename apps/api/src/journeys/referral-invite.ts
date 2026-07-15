import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const referralInvite = defineJourney({
  meta: {
    id: "referral-invite",
    tier: "acquisition",
    name: "Referral — Post-Achievement Invite",
    enabled: true,
    trigger: { event: Events.MILESTONE_REACHED },
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: days(2),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2), label: "post-achievement" });

    const { found: isActive30d } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.SESSION_COMPLETED,
      within: days(30),
    });
    if (!isActive30d) {
      return;
    }

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_ACHIEVEMENT,
      subject: "Share the love — invite a friend",
      journeyName: user.journeyName,
      props: { ctaText: "Invite a Friend" },
    });
  },
});
