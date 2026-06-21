import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { startEveSession } from "../lib/eve.js";
import { SavePlay } from "../webhook-sources/eve.js";
import { Events, Templates } from "./constants/index.js";

/**
 * Tier-3 AI churn-save journey — durable HITL via Eve.
 *
 * Flow:
 *  1. Triggered by `churn.risk_flagged` with `score >= 70`.
 *  2. Opens an Eve agent session to research the user and optionally involve a
 *     human (HITL) before deciding on a save play.
 *  3. Parks on `ctx.waitForEvent(AGENT_COMPLETED)` for up to 7 days.
 *     Eve POSTs back to `POST /v1/webhooks/eve` (HMAC-signed) when done.
 *  4. Parses Eve's `play` from the event properties and sends a save email
 *     unless the agent chose to suppress or the user has reactivated / unsub'd.
 *
 * Exit: `churn.reactivated` — the journey exits cleanly and no email is sent
 * even if the parked wait was about to resume.
 */
export const aiChurnSave = defineJourney({
  meta: {
    id: "ai-churn-save",
    name: "AI Churn-Save — Eve HITL",
    enabled: true,
    trigger: {
      event: Events.CHURN_RISK_FLAGGED,
      where: [
        { type: "property", property: "score", operator: "gte", value: 70 },
      ],
    },
    entryLimit: "once_per_period",
    suppress: days(30),
    exitOn: [{ event: Events.REACTIVATED }, { event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await ctx.checkpoint("starting-eve-session");

    // Fire off the Eve agent session. Eve will research the user, optionally
    // loop in a human, decide on a play, and POST the result back to
    // POST /v1/webhooks/eve — which the eveSource transform turns into an
    // AGENT_COMPLETED ingest event that resumes this wait.
    await startEveSession({
      agent: "retention-strategist",
      userId: user.id,
      callbackEvent: Events.AGENT_COMPLETED,
      input: {
        email: user.email,
        properties: user.properties,
      },
    });

    await ctx.checkpoint("waiting-for-agent");

    // Park until Eve calls back or 7 days elapse.
    const result = await ctx.waitForEvent({
      event: Events.AGENT_COMPLETED,
      timeout: days(7),
      label: "eve-agent-completed",
    });

    // Timed out: Eve never responded within the window — exit silently.
    if (result.timedOut) {
      return;
    }

    // Eve's transform serialises the play as scalar properties:
    //   playAction, playReason, playDetail (optional).
    const rawPlay = {
      action: result.properties?.playAction,
      reason: result.properties?.playReason,
      detail: result.properties?.playDetail,
    };

    // Validate the play shape before acting on it.
    const parsed = SavePlay.safeParse(rawPlay);
    if (!parsed.success) {
      // Malformed callback — exit without sending.
      return;
    }

    const play = parsed.data;

    // Agent chose not to intervene.
    if (play.action === "suppress") {
      return;
    }

    // Re-check subscription after the (potentially long) wait.
    const isStillSubscribed = await ctx.guard.isSubscribed();
    if (!isStillSubscribed) {
      return;
    }

    await ctx.checkpoint("sending-save-email");

    const displayName = user.email.split("@")[0] ?? "there";

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CHURN_SAVE,
      subject: "We'd love to keep you",
      props: {
        name: displayName,
        offerDetail: play.detail,
      },
      journeyName: user.journeyName,
    });
  },
});
