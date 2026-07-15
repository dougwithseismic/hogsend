import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePromptFrame,
  INITIAL_PROMPT_FRAME,
  movePromptFrame,
  PROMPT_SCENARIOS,
  submitPromptFrame,
} from "./agent-prompt-loop-state.ts";

test("the hero loop covers seven distinct lifecycle jobs", () => {
  assert.equal(PROMPT_SCENARIOS.length, 7);
  assert.match(PROMPT_SCENARIOS[0].prompt, /win-back journey/i);
  assert.match(PROMPT_SCENARIOS[1].prompt, /losing the most users/i);
  assert.match(PROMPT_SCENARIOS[2].prompt, /Discord/i);
  assert.match(PROMPT_SCENARIOS[3].prompt, /failed payment/i);
  assert.match(PROMPT_SCENARIOS[4].prompt, /acme\.com/i);
  assert.match(PROMPT_SCENARIOS[4].prompt, /Slack/i);
  assert.match(PROMPT_SCENARIOS[4].prompt, /Telegram/i);
  assert.match(PROMPT_SCENARIOS[4].prompt, /Cal\.com/i);
  assert.match(PROMPT_SCENARIOS[5].prompt, /new user signs up/i);
  assert.match(PROMPT_SCENARIOS[5].prompt, /welcome series/i);
  assert.match(PROMPT_SCENARIOS[5].prompt, /created a project/i);
  assert.match(PROMPT_SCENARIOS[5].prompt, /3 days/i);
  assert.match(PROMPT_SCENARIOS[5].prompt, /Slack/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /requests a callback/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /Deepgram/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /Twilio/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /After the call/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /founder/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /account executive/i);
});

test("a prompt types completely, pings send, then advances", () => {
  const promptLength = PROMPT_SCENARIOS[0].prompt.length;
  let frame = {
    ...INITIAL_PROMPT_FRAME,
    visibleCharacters: promptLength - 1,
  };

  frame = advancePromptFrame(frame);
  assert.deepEqual(frame, {
    promptIndex: 0,
    visibleCharacters: promptLength,
    phase: "typing",
  });

  frame = advancePromptFrame(frame);
  assert.equal(frame.phase, "ready");

  frame = advancePromptFrame(frame);
  assert.equal(frame.phase, "sending");

  frame = advancePromptFrame(frame);
  assert.deepEqual(frame, {
    promptIndex: 1,
    visibleCharacters: 0,
    phase: "typing",
  });
});

test("the final prompt loops back to the first", () => {
  const lastIndex = PROMPT_SCENARIOS.length - 1;
  const frame = advancePromptFrame({
    promptIndex: lastIndex,
    visibleCharacters: PROMPT_SCENARIOS[lastIndex].prompt.length,
    phase: "sending",
  });

  assert.deepEqual(frame, INITIAL_PROMPT_FRAME);
});

test("manual navigation resets typing and wraps in both directions", () => {
  assert.deepEqual(movePromptFrame(INITIAL_PROMPT_FRAME, 1), {
    promptIndex: 1,
    visibleCharacters: 0,
    phase: "typing",
  });
  assert.deepEqual(movePromptFrame(INITIAL_PROMPT_FRAME, -1), {
    promptIndex: PROMPT_SCENARIOS.length - 1,
    visibleCharacters: 0,
    phase: "typing",
  });
});

test("manual send completes the prompt and enters the sending phase", () => {
  const frame = submitPromptFrame({
    promptIndex: 2,
    visibleCharacters: 12,
    phase: "typing",
  });

  assert.deepEqual(frame, {
    promptIndex: 2,
    visibleCharacters: PROMPT_SCENARIOS[2].prompt.length,
    phase: "sending",
  });
});
