import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

/**
 * Personal follow-up for the lowest NPS answers — fed by the semantic-link
 * pipeline: the feedback-nps journey fires `nps.detractor { score }` via
 * `ctx.trigger`, and this journey gates enrollment on the score with the
 * `where` BUILDER form. The function resolves once at definition time to the
 * same `PropertyCondition` data the declarative form produces, so the
 * registry, admin routes, and Studio still see plain data.
 */
export const detractorRescue = defineJourney({
  meta: {
    id: "detractor-rescue",
    name: "Detractor — personal follow-up",
    enabled: true,
    trigger: {
      event: Events.NPS_DETRACTOR,
      where: (b) => b.prop("score").lte(3),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    suppress: days(1),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // A short cool-off reads better than an instant automated reply to a bad
    // score; long enough to feel considered, short enough to matter.
    await ctx.sleep({ duration: hours(2), label: "cool-off" });

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.REACTIVATION_CHECKIN,
      subject: "Can we make this right?",
      journeyName: user.journeyName,
    });
  },
});
