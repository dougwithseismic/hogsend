import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { decideNextBestAction } from "../agents/reengagement-strategist.js";
import { Events, Templates } from "./constants/index.js";

/**
 * Maps the agent's `action` decision to the matching template key.
 * `suppress` is handled before this map is consulted.
 */
const ACTION_TEMPLATE_MAP = {
  reengage_tip_a: Templates.REENGAGE_TIP_A,
  reengage_tip_b: Templates.REENGAGE_TIP_B,
  reengage_webinar: Templates.REENGAGE_WEBINAR,
} as const;

/** Subject lines per action — keeps the agent decision out of the templates. */
const ACTION_SUBJECT_MAP = {
  reengage_tip_a: "A quick win while you were away",
  reengage_tip_b: "An advanced pattern you might not have tried",
  reengage_webinar: "Get your first journey live — join us",
} as const;

export const aiReengagement = defineJourney({
  meta: {
    id: "ai-reengagement",
    name: "AI Re-engagement — Next Best Action",
    enabled: true,
    trigger: { event: Events.DORMANT_30D },
    entryLimit: "once_per_period",
    suppress: days(60),
    exitOn: [{ event: Events.USER_ACTIVATED }, { event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    await ctx.checkpoint("deciding-action");

    // Ask the AI strategist which action (or suppress) fits this user best.
    // The decision is NON-DETERMINISTIC (an LLM call) and it picks the template
    // that becomes the send's exactly-once key discriminant — so a replay that
    // re-ran the LLM could choose a DIFFERENT template, derive a non-colliding
    // key, and deliver a second (different) email. `ctx.once` records the chosen
    // action in the enrollment's state row the first time and replays it
    // verbatim thereafter (durable on ANY engine), so the send key is stable.
    const { action } = await ctx.once("reengagement-action", () =>
      decideNextBestAction(user, ctx),
    );

    // If the agent chose to stay silent, return without sending anything.
    if (action === "suppress") {
      return;
    }

    const template = ACTION_TEMPLATE_MAP[action];
    const subject = ACTION_SUBJECT_MAP[action];
    const displayName = user.email.split("@")[0] ?? "there";

    await ctx.checkpoint("sending-email");

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template,
      subject,
      props: {
        name: displayName,
      },
      journeyName: user.journeyName,
    });
  },
});
