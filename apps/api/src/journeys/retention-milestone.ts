import { days } from "@hogsend/core";
import { sendJourneyEmail } from "../lib/journey-email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const retentionMilestone = defineJourney({
  meta: {
    id: "retention-milestone",
    name: "Retention — Milestone Celebration",
    enabled: true,
    trigger: { event: Events.MILESTONE_REACHED },
    entryLimit: "unlimited",
    suppressHours: 24,
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await sendJourneyEmail(user, {
      template: Templates.RETENTION_ACHIEVEMENT,
      subject: "Congratulations on your achievement!",
    });

    await ctx.sleep({ duration: days(1), label: "post-milestone" });

    await sendJourneyEmail(user, {
      template: Templates.ACTIVATION_COMMUNITY_ALT,
      subject: "Share your achievement with the community",
    });
  },
});
