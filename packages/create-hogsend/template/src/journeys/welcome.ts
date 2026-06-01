import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

/**
 * Example journey — a trimmed welcome series.
 *
 * Anatomy of a journey:
 *   - `meta.trigger.event`  the event that enrolls a user
 *   - `meta.entryLimit`     "once" | "once_per_period" | "unlimited"
 *   - `meta.suppress`       cool-down before re-entry is allowed
 *   - `meta.exitOn`         events that pull a user out mid-flow
 *   - `run(user, ctx)`      your control flow: send emails, sleep, branch
 *
 * Copy this file to add your own journeys, then register them in
 * `src/journeys/index.ts`.
 */
export const welcome = defineJourney({
  meta: {
    id: "welcome",
    name: "Welcome Series",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // 1. Send the welcome email immediately.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
      journeyName: user.journeyName,
    });

    // 2. Wait, then check whether they activated. `ctx.sleep` is a durable
    //    Hatchet sleep — the worker can restart and the journey resumes.
    await ctx.sleep({ duration: days(2), label: "post-welcome" });

    const { found: hasUsedFeature } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
    });

    // 3. Branch: nudge users who haven't activated yet.
    if (!hasUsedFeature) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ACTIVATION_NUDGE,
        subject: "You haven't tried the key feature yet",
        journeyName: user.journeyName,
      });
    }
  },
});
