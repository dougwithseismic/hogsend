export const PROMPT_SCENARIOS = [
  {
    id: "winback",
    file: "src/journeys/winback.ts",
    prompt:
      "Add a win-back journey: trigger when someone enters the went-dormant bucket, check in, wait 7 days, then send the offer. Exit the moment they come back.",
  },
  {
    id: "lifecycle-leak",
    file: "src/journeys/retention.ts",
    prompt:
      "Where are we losing the most users? Find the biggest lifecycle leak and build a win-back journey to bring them back.",
  },
  {
    id: "prerelease-discord",
    file: "src/journeys/prerelease-discord.ts",
    prompt:
      "DM everyone on Discord who signed up for the pre-release. Stop the moment they activate.",
  },
  {
    id: "payment-recovery",
    file: "src/journeys/payment-recovery.ts",
    prompt:
      "Recover every failed payment: warn them in-app, follow up by email, and stop as soon as billing recovers.",
  },
  {
    id: "proposal-approval",
    file: "src/journeys/acme-proposal.ts",
    prompt:
      "Generate a proposal for acme.com and send it to Slack for approval. Once approved, message the prospect on Telegram and invite them to a call using our Cal.com link.",
  },
  {
    id: "onboarding",
    file: "src/journeys/onboarding.ts",
    prompt:
      "When a new user signs up, send them our welcome series. If they haven't created a project within 3 days, follow up with a nudge and ping our sales rep in Slack.",
  },
  {
    id: "voice-lead-qualification",
    file: "src/journeys/voice-lead-qualification.ts",
    prompt:
      "When a new lead requests a callback, have our Deepgram or Twilio voice agent call them to understand what they need. After the call, email a summary and introduce them to the founder and their assigned account executive.",
  },
] as const;

export type PromptPhase = "typing" | "ready" | "sending";

export type PromptFrame = {
  promptIndex: number;
  visibleCharacters: number;
  phase: PromptPhase;
};

export const INITIAL_PROMPT_FRAME: PromptFrame = {
  promptIndex: 0,
  visibleCharacters: 0,
  phase: "typing",
};

export function advancePromptFrame(frame: PromptFrame): PromptFrame {
  const prompt = PROMPT_SCENARIOS[frame.promptIndex];

  if (frame.phase === "typing") {
    if (frame.visibleCharacters < prompt.prompt.length) {
      return {
        ...frame,
        visibleCharacters: frame.visibleCharacters + 1,
      };
    }

    return { ...frame, phase: "ready" };
  }

  if (frame.phase === "ready") {
    return { ...frame, phase: "sending" };
  }

  const promptIndex = (frame.promptIndex + 1) % PROMPT_SCENARIOS.length;
  return {
    promptIndex,
    visibleCharacters: 0,
    phase: "typing",
  };
}

export function movePromptFrame(
  frame: PromptFrame,
  direction: -1 | 1,
): PromptFrame {
  const promptIndex =
    (frame.promptIndex + direction + PROMPT_SCENARIOS.length) %
    PROMPT_SCENARIOS.length;

  return {
    promptIndex,
    visibleCharacters: 0,
    phase: "typing",
  };
}

export function submitPromptFrame(frame: PromptFrame): PromptFrame {
  return {
    ...frame,
    visibleCharacters: PROMPT_SCENARIOS[frame.promptIndex].prompt.length,
    phase: "sending",
  };
}
