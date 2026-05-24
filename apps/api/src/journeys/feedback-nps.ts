import { defineJourney } from "./define-journey.js";

export const feedbackNps = defineJourney({
  meta: {
    id: "feedback-nps",
    name: "Feedback — NPS Survey",
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppressHours: 24,
    exitOn: [{ event: "user.deleted" }, { event: "nps.submitted" }],
  },

  run: async (user, ctx) => {
    await ctx.sleepFor("336h", "wait:day-14");

    await ctx.sendEmail(user, {
      template: "feedback-nps-survey",
      subject: "Quick question — how are we doing?",
    });

    await ctx.sleepFor("72h", "wait:nps-reminder");

    const hasSubmitted = await ctx.hasEvent(user.id, "nps.submitted", {
      withinHours: 72,
    });

    if (!hasSubmitted) {
      await ctx.sendEmail(user, {
        template: "feedback-nps-survey",
        subject: "We'd still love your feedback (10 seconds)",
      });
    }

    await ctx.sleepFor("1104h", "wait:day-60");

    const hasSubmittedDay60 = await ctx.hasEvent(user.id, "nps.submitted", {
      withinHours: 1104,
    });
    if (!hasSubmittedDay60) {
      await ctx.sendEmail(user, {
        template: "feedback-nps-survey",
        subject: "How's it going? Quick check-in",
      });
    }
  },
});
