import {
  days,
  defineJourney,
  hours,
  sendEmail,
} from "@hogsend/engine/journeys";
import { Events, Templates } from "./constants/index.js";

/**
 * Example lifecycle journey — a trial-expiring reminder. Enroll a user when
 * their trial starts; the journey durably waits
 * out the trial, then emails them a few days before it ends — unless they've
 * already converted, in which case `exitOn` pulls them out cleanly.
 *
 * This pairs with the `lifecycle/trial-expiring` email template. Emit
 * `trial.started` from your billing/signup code (e.g.
 * `hs.events.send({ name: "trial.started", userId, contactProperties: {...} })`),
 * and `subscription.started` when they pay.
 *
 * Copy this file to add your own journeys, then register them in
 * `src/journeys/index.ts`.
 */
export const trialExpiring = defineJourney({
  meta: {
    id: "trial-expiring",
    name: "Trial Expiring Reminder",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    // `once` means a user can't re-enter, so suppress is moot — but it's
    // required. Use a token cool-down.
    suppress: hours(0),
    // Converting exits the journey, so the reminder never fires for paid users.
    exitOn: [
      { event: Events.SUBSCRIPTION_STARTED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    // Assume a 14-day trial; remind 3 days before it ends. Tune to your plan.
    const TRIAL_LENGTH_DAYS = 14;
    const REMIND_BEFORE_DAYS = 3;

    // 1. Durable wait until 3 days before the trial ends. The worker can restart
    //    and the journey resumes — Hatchet owns the timer.
    await ctx.sleep({
      duration: days(TRIAL_LENGTH_DAYS - REMIND_BEFORE_DAYS),
      label: "until-trial-reminder",
    });

    // 2. A long sleep means anything could have changed. `exitOn` already pulls
    //    out converters; re-check subscription in case they unsubscribed from
    //    email (unsubscribe does NOT exit the journey).
    if (!(await ctx.guard.isSubscribed())) return;

    // 3. Send the reminder. `props` flow straight into the template component;
    //    `sendEmail` fills `name` from the contact when omitted.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.LIFECYCLE_TRIAL_EXPIRING,
      subject: "Your trial is ending soon",
      journeyName: user.journeyName,
      props: { daysLeft: REMIND_BEFORE_DAYS },
    });
  },
});
