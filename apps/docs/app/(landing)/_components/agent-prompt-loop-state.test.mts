import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  advancePromptFrame,
  completePromptFrame,
  INITIAL_PROMPT_FRAME,
  movePromptFrame,
  PROMPT_SCENARIOS,
} from "./agent-prompt-loop-state.ts";

test("the hero loop covers seven distinct lifecycle jobs", () => {
  assert.equal(PROMPT_SCENARIOS.length, 7);
  assert.match(PROMPT_SCENARIOS[0].prompt, /win-back journey/i);
  assert.match(PROMPT_SCENARIOS[1].prompt, /losing the most users/i);
  assert.match(PROMPT_SCENARIOS[2].prompt, /Discord/i);
  assert.match(PROMPT_SCENARIOS[2].prompt, /unique Stripe discount code/i);
  assert.match(PROMPT_SCENARIOS[2].prompt, /email/i);
  assert.match(PROMPT_SCENARIOS[2].prompt, /within 2 days/i);
  assert.match(PROMPT_SCENARIOS[3].prompt, /payment-recovery journey/i);
  assert.match(PROMPT_SCENARIOS[3].prompt, /in-app warning/i);
  assert.match(PROMPT_SCENARIOS[3].prompt, /email/i);
  assert.match(PROMPT_SCENARIOS[3].prompt, /billing recovers/i);
  assert.match(PROMPT_SCENARIOS[4].prompt, /lead becomes qualified/i);
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
  assert.match(PROMPT_SCENARIOS[6].prompt, /clarify what they need/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /email a summary/i);
  assert.match(PROMPT_SCENARIOS[6].prompt, /HubSpot funnel/i);
  assert.doesNotMatch(PROMPT_SCENARIOS[6].prompt, /Twilio/i);
});

test("every session replays real agent output and ends green", () => {
  for (const scenario of PROMPT_SCENARIOS) {
    assert.ok(scenario.output.length >= 4, `${scenario.id} output too thin`);
    assert.ok(
      scenario.output.some(
        (line) => line.kind === "write" && line.text === scenario.file,
      ),
      `${scenario.id} never writes its journey file`,
    );
    assert.equal(scenario.output.at(-1)?.kind, "ok");
  }
});

test("a session types, streams its output lines, holds, then advances", () => {
  const promptLength = PROMPT_SCENARIOS[0].prompt.length;
  let frame = { ...INITIAL_PROMPT_FRAME, visibleCharacters: promptLength - 1 };

  frame = advancePromptFrame(frame);
  assert.deepEqual(frame, {
    promptIndex: 0,
    visibleCharacters: promptLength,
    visibleLines: 0,
    phase: "typing",
  });

  frame = advancePromptFrame(frame);
  assert.equal(frame.phase, "running");

  for (let i = 1; i <= PROMPT_SCENARIOS[0].output.length; i += 1) {
    frame = advancePromptFrame(frame);
    assert.equal(frame.visibleLines, i);
    assert.equal(frame.phase, "running");
  }

  frame = advancePromptFrame(frame);
  assert.equal(frame.phase, "done");

  frame = advancePromptFrame(frame);
  assert.deepEqual(frame, {
    promptIndex: 1,
    visibleCharacters: 0,
    visibleLines: 0,
    phase: "typing",
  });
});

test("the final session loops back to the first", () => {
  const lastIndex = PROMPT_SCENARIOS.length - 1;
  const frame = advancePromptFrame(
    completePromptFrame({ ...INITIAL_PROMPT_FRAME, promptIndex: lastIndex }),
  );

  assert.deepEqual(frame, INITIAL_PROMPT_FRAME);
});

test("manual navigation shows the whole prompt and wraps in both directions", () => {
  assert.deepEqual(movePromptFrame(INITIAL_PROMPT_FRAME, 1), {
    promptIndex: 1,
    visibleCharacters: PROMPT_SCENARIOS[1].prompt.length,
    visibleLines: 0,
    phase: "running",
  });
  assert.deepEqual(movePromptFrame(INITIAL_PROMPT_FRAME, -1), {
    promptIndex: PROMPT_SCENARIOS.length - 1,
    visibleCharacters: PROMPT_SCENARIOS.at(-1)?.prompt.length,
    visibleLines: 0,
    phase: "running",
  });
});

test("completing a session shows the full prompt and every output line", () => {
  const frame = completePromptFrame({
    promptIndex: 3,
    visibleCharacters: 12,
    visibleLines: 1,
    phase: "typing",
  });

  assert.deepEqual(frame, {
    promptIndex: 3,
    visibleCharacters: PROMPT_SCENARIOS[3].prompt.length,
    visibleLines: PROMPT_SCENARIOS[3].output.length,
    phase: "done",
  });
});

test("the terminal pauses on interaction and respects reduced motion", () => {
  const source = readFileSync(
    new URL("./agent-prompt-loop.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /onMouseEnter/);
  assert.match(source, /onMouseLeave/);
  assert.match(source, /onFocusCapture/);
  assert.match(source, /onBlurCapture/);
  assert.match(source, /isHolding = isHovered \|\| isFocusWithin/);
  assert.match(source, /reduceMotion \|\| isHolding/);
  assert.match(source, /completePromptFrame/);
  assert.match(source, /prefers-reduced-motion/);
});
