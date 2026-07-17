export type OutputLine = {
  kind: "info" | "write" | "ok";
  text: string;
};

export const PROMPT_SCENARIOS: readonly {
  id: string;
  file: string;
  prompt: string;
  output: readonly OutputLine[];
}[] = [
  {
    id: "winback",
    file: "src/journeys/winback.ts",
    prompt:
      "Add a win-back journey: trigger when someone enters the went-dormant bucket, check in, wait 7 days, then send the offer. Exit the moment they come back.",
    output: [
      { kind: "info", text: "planning · 3 steps, 1 durable wait" },
      { kind: "write", text: "src/journeys/winback.ts" },
      { kind: "write", text: "src/emails/winback-offer.tsx" },
      {
        kind: "info",
        text: "trigger bucket.went_dormant · exit on contact.active",
      },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "lifecycle-leak",
    file: "src/journeys/retention.ts",
    prompt:
      "Look at our funnels, find where we're losing the most users, and build a journey that re-engages them before they go dormant.",
    output: [
      {
        kind: "info",
        text: "reading funnels · largest drop: activation → week 2",
      },
      { kind: "info", text: "planning · re-engage before day 10" },
      { kind: "write", text: "src/journeys/retention.ts" },
      { kind: "write", text: "src/emails/week-two-checkin.tsx" },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "prerelease-discord",
    file: "src/journeys/prerelease-discord.ts",
    prompt:
      "When someone joins the pre-release role on our Discord, DM them a unique Stripe discount code, and follow up by email if they haven't used it within 2 days.",
    output: [
      { kind: "info", text: "trigger · discord role pre-release granted" },
      { kind: "write", text: "src/journeys/prerelease-discord.ts" },
      {
        kind: "info",
        text: "mints a stripe code · waitForEvent(code.redeemed, days(2))",
      },
      { kind: "write", text: "src/emails/code-reminder.tsx" },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "payment-recovery",
    file: "src/journeys/payment-recovery.ts",
    prompt:
      "Build a payment-recovery journey: when a charge fails, show an in-app warning, follow up by email, and exit the moment billing recovers.",
    output: [
      {
        kind: "info",
        text: "planning · in-app warning → email → exit on invoice.paid",
      },
      { kind: "write", text: "src/journeys/payment-recovery.ts" },
      { kind: "write", text: "src/emails/payment-failed.tsx" },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "proposal-approval",
    file: "src/journeys/proposal-approval.ts",
    prompt:
      "When a lead becomes qualified, draft a proposal and send it to Slack for approval. Once approved, message them on Telegram and invite them to a call with our Cal.com link.",
    output: [
      { kind: "write", text: "src/journeys/proposal-approval.ts" },
      {
        kind: "info",
        text: "slack approval gate · ctx.waitForEvent(proposal.approved)",
      },
      { kind: "info", text: "on approval · telegram DM + cal.com invite" },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "onboarding",
    file: "src/journeys/onboarding.ts",
    prompt:
      "When a new user signs up, send them our welcome series. If they haven't created a project within 3 days, follow up with a nudge and ping our sales rep in Slack.",
    output: [
      { kind: "info", text: "planning · welcome series + days(3) nudge" },
      { kind: "write", text: "src/journeys/onboarding.ts" },
      { kind: "write", text: "src/emails/welcome.tsx" },
      {
        kind: "info",
        text: "no project by day 3 → nudge email + slack ping to sales",
      },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
  {
    id: "voice-lead-qualification",
    file: "src/journeys/voice-lead-qualification.ts",
    prompt:
      "When a new lead requests a callback, have our Deepgram voice agent call to clarify what they need, then email a summary and add them to our HubSpot funnel.",
    output: [
      { kind: "info", text: "wiring deepgram voice agent · callback trigger" },
      { kind: "write", text: "src/journeys/voice-lead-qualification.ts" },
      { kind: "info", text: "call → summary email → hubspot funnel" },
      { kind: "ok", text: "typecheck clean · journey registered" },
    ],
  },
];

export type PromptPhase = "typing" | "running" | "done";

export type PromptFrame = {
  promptIndex: number;
  visibleCharacters: number;
  visibleLines: number;
  phase: PromptPhase;
};

export const INITIAL_PROMPT_FRAME: PromptFrame = {
  promptIndex: 0,
  visibleCharacters: 0,
  visibleLines: 0,
  phase: "typing",
};

/** One tick of the terminal replay: type → emit output lines → hold → next. */
export function advancePromptFrame(frame: PromptFrame): PromptFrame {
  const scenario = PROMPT_SCENARIOS[frame.promptIndex];

  if (frame.phase === "typing") {
    if (frame.visibleCharacters < scenario.prompt.length) {
      return { ...frame, visibleCharacters: frame.visibleCharacters + 1 };
    }

    return { ...frame, phase: "running" };
  }

  if (frame.phase === "running") {
    if (frame.visibleLines < scenario.output.length) {
      return { ...frame, visibleLines: frame.visibleLines + 1 };
    }

    return { ...frame, phase: "done" };
  }

  return {
    promptIndex: (frame.promptIndex + 1) % PROMPT_SCENARIOS.length,
    visibleCharacters: 0,
    visibleLines: 0,
    phase: "typing",
  };
}

/**
 * Manual navigation shows the chosen prompt whole, then streams its output —
 * a browse action shouldn't make the reader sit through the typing replay.
 */
export function movePromptFrame(
  frame: PromptFrame,
  direction: -1 | 1,
): PromptFrame {
  const promptIndex =
    (frame.promptIndex + direction + PROMPT_SCENARIOS.length) %
    PROMPT_SCENARIOS.length;

  return {
    promptIndex,
    visibleCharacters: PROMPT_SCENARIOS[promptIndex].prompt.length,
    visibleLines: 0,
    phase: "running",
  };
}

/** Jump the current session to its finished state (reduced motion, holds). */
export function completePromptFrame(frame: PromptFrame): PromptFrame {
  const scenario = PROMPT_SCENARIOS[frame.promptIndex];

  return {
    ...frame,
    visibleCharacters: scenario.prompt.length,
    visibleLines: scenario.output.length,
    phase: "done",
  };
}
