import { hours } from "@hogsend/core";
import { defineJourney, isE164, startCall } from "@hogsend/engine";
import { Events } from "./constants/events.js";

/**
 * Voice — Lead qualifier. Fires on `user.created` and places an AI voice call to
 * contacts with a valid E.164 `phone`. Demonstrates the voice channel end-to-end:
 * `startCall` synthesizes the `appointment-setter` agent, runs the consent gate
 * (the `voice` channel is EXPLICIT OPT-IN — TCPA requires prior express written
 * consent for AI marketing calls, so a contact with no `categories.voice` grant
 * silently no-ops with `no_consent`) + the DNC / calling-hours / frequency guards,
 * places the call through the active provider (Vapi), then WAITS for the terminal
 * outcome the webhook ingests and branches on it — replay-safe like `sendSms`,
 * with the enrollment auto-attributed from the journey boundary.
 *
 * A contact with no phone (or a non-E.164 one) exits early — voice is additive.
 */
export const voiceLeadQualifier = defineJourney({
  meta: {
    id: "voice-lead-qualifier",
    name: "Voice — Lead qualifier",
    // Off by default — a real deploy enables it once a Vapi number + consent
    // collection are in place (an AI call is the highest-touch channel).
    enabled: false,
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
    suppress: hours(0),
  },

  run: async (user, ctx) => {
    const phone = user.properties.phone ? String(user.properties.phone) : null;
    if (!phone || !isE164(phone)) return;

    const result = await startCall({
      to: phone,
      userId: user.id,
      agent: "appointment-setter",
      journeyName: "Voice — Lead qualifier",
      props: {
        businessName: "Hogsend",
        firstName: user.properties.firstName as string | undefined,
      },
    });
    // Non-connect verdicts (no_consent / suppressed / skipped) end the run here.
    if (result.status !== "started") return;

    // Wait for the call to finish, then branch on the outcome the webhook
    // ingested (e.g. book a follow-up, or fall back to SMS/email). Never put the
    // awaited event in `exitOn`.
    const { timedOut, properties } = await ctx.waitForEvent({
      event: "voice.call_ended",
      timeout: { minutes: 15 },
    });
    if (timedOut) return;

    ctx.checkpoint(
      properties?.reason?.toString().includes("no-answer")
        ? "voice:no-answer"
        : "voice:completed",
    );
  },
});
