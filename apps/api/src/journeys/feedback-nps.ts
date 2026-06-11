import { days } from "@hogsend/core";
import { defineJourney, getPostHog, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

/**
 * NPS survey via SEMANTIC LINKS: the score buttons in the email are
 * EmailActions carrying `nps.submitted { score }` — the click IS the answer.
 * The journey waits durably for that event (first answer per send wins,
 * scanner bursts suppressed by the engine), then branches on the score:
 * promoters get a thank-you path, detractors fire `nps.detractor` for any
 * follow-up journey to pick up.
 *
 * NOTE: `nps.submitted` is deliberately NOT in `exitOn` — an event the run
 * REACTS to via `ctx.waitForEvent` must not also exit the journey (the exit
 * would abort the wait before the branching code runs).
 */
export const feedbackNps = defineJourney({
  meta: {
    id: "feedback-nps",
    name: "Feedback — NPS Survey",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }],
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

    let answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
      label: "await-score",
    });

    if (answer.timedOut) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.FEEDBACK_NPS_SURVEY,
        subject: "We'd still love your feedback (10 seconds)",
        journeyName: user.journeyName,
      });

      answer = await ctx.waitForEvent({
        event: Events.NPS_SUBMITTED,
        timeout: days(7),
        label: "await-score-reminder",
      });
    }

    if (answer.timedOut) return;

    const score =
      typeof answer.properties?.score === "number"
        ? answer.properties.score
        : null;
    if (score === null) return;

    await ctx.checkpoint(`scored-${score}`);
    // Person enrichment is a standalone service, not a ctx primitive — no-op
    // without POSTHOG_API_KEY.
    getPostHog()?.identify(user.id, {
      nps_score: score,
      nps_responded_at: new Date().toISOString(),
    });

    if (score <= 6) {
      await ctx.trigger({
        event: Events.NPS_DETRACTOR,
        userId: user.id,
        properties: { score },
      });
    }
  },
});
