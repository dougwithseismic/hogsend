import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

/**
 * Example journey — SEMANTIC LINKS end to end.
 *
 * The check-in email's yes/no buttons are `EmailAction`s: clicking one fires
 * `checkin.answered { answer }` through the full ingest pipeline (journeys,
 * user_events, outbound destinations). This journey waits durably for that
 * answer and branches on `properties` — no polling, no landing-page wiring.
 * Answers confirm after a ~30s window so scanner click-bursts are judged in
 * full before anything is recorded.
 *
 * Two rules worth copying:
 *   - An event you REACT to via `ctx.waitForEvent` must NOT be in `exitOn`
 *     (the exit would abort the wait before your branch runs).
 *   - `result.properties` is best-effort scalars — guard the type before
 *     branching on it.
 */
export const feedbackCheckin = defineJourney({
  meta: {
    id: "feedback-checkin",
    name: "Feedback — quick check-in",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(7), label: "day-7" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.FEEDBACK_CHECKIN,
      subject: "Quick check-in — how's it going?",
      journeyName: user.journeyName,
    });

    const answer = await ctx.waitForEvent({
      event: Events.CHECKIN_ANSWERED,
      timeout: days(5),
      label: "await-answer",
    });

    if (answer.timedOut) return; // no answer — leave them be

    if (answer.properties?.answer === "no") {
      // They're stuck — follow up. Swap this for a nudge email, a Slack
      // alert via a destination, or a cross-journey `ctx.trigger`.
      await ctx.checkpoint("needs-help");
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_NUDGE,
        subject: "Let's get you unstuck",
        journeyName: user.journeyName,
      });
    }
  },
});
