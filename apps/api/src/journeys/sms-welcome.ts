import { hours } from "@hogsend/core";
import { defineJourney, isE164, sendSms } from "@hogsend/engine";
import { Events } from "./constants/events.js";

/**
 * SMS — Welcome. Fires on `user.created` and texts a welcome to contacts that
 * carry a valid E.164 `phone` property. Demonstrates the SMS channel end-to-end:
 * `sendSms` renders the `welcome-sms` React template to plain text, runs the
 * consent gate (the `sms` channel is EXPLICIT OPT-IN — a contact with no grant
 * silently no-ops with `no_consent`, which is correct: welcome texts are
 * marketing under TCPA), rewrites links, appends the STOP footer, and delivers
 * through the active provider (Twilio) — replay-safe like `sendEmail`, with
 * the enrollment auto-attributed from the journey boundary.
 *
 * A contact with no phone (or a non-E.164 one) simply exits early — the SMS
 * channel is additive, never required.
 */
export const smsWelcome = defineJourney({
  meta: {
    id: "sms-welcome",
    name: "SMS — Welcome",
    enabled: true,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(0),
  },

  run: async (user, _ctx) => {
    const phone = user.properties.phone ? String(user.properties.phone) : null;
    if (!phone || !isE164(phone)) return;

    await sendSms({
      to: phone,
      userId: user.id,
      template: "welcome-sms",
      journeyName: "SMS — Welcome",
      props: { name: (user.properties.firstName as string) ?? undefined },
    });
  },
});
