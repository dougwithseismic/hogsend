import { days } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const retentionMilestone = defineJourney({
  meta: {
    id: "retention-milestone",
    name: "Retention — Milestone Celebration",
    enabled: true,
    trigger: { event: Events.MILESTONE_REACHED },
    entryLimit: "unlimited",
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_ACHIEVEMENT,
      subject: "Congratulations on your achievement!",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(1), label: "post-milestone" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_COMMUNITY_ALT,
      subject: "Share your achievement with the community",
      journeyName: user.journeyName,
    });
  },
});
