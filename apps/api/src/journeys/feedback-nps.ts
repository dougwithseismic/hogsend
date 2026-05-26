import { days } from "@hogsend/core";
import { sendEmail } from "../lib/email.js";
import { Events, Templates } from "./constants/index.js";
import { defineJourney } from "./define-journey.js";

export const feedbackNps = defineJourney({
  meta: {
    id: "feedback-nps",
    name: "Feedback — NPS Survey",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }, { event: Events.NPS_SUBMITTED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(14), label: "day-14" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.FEEDBACK_NPS_SURVEY,
      subject: "Quick question — how are we doing?",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(3), label: "nps-reminder" });

    const { found: hasSubmitted } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.NPS_SUBMITTED,
      within: days(3),
    });

    if (!hasSubmitted) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.FEEDBACK_NPS_SURVEY,
        subject: "We'd still love your feedback (10 seconds)",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(46), label: "day-60" });

    const { found: hasSubmittedDay60 } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.NPS_SUBMITTED,
      within: days(46),
    });
    if (!hasSubmittedDay60) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.FEEDBACK_NPS_SURVEY,
        subject: "How's it going? Quick check-in",
        journeyName: user.journeyName,
      });
    }
  },
});
