import { describe, expect, it } from "vitest";
import { campaign } from "../../src/videos/codex-campaign/campaign";
import {
  createVoicePlan,
  resolveVoiceProvider,
  voiceContentHash,
} from "./voice";

describe("voice cache plan", () => {
  it("uses OpenAI unless a fallback is explicitly requested", () => {
    expect(resolveVoiceProvider(undefined)).toBe("openai");
    expect(resolveVoiceProvider("system")).toBe("system");
  });

  it("hashes provider settings and copy deterministically", () => {
    const first = voiceContentHash({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      instructions: "Confident product builder.",
      text: "Build it.",
    });
    const second = voiceContentHash({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      instructions: "Confident product builder.",
      text: "Build it.",
    });
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it("creates one stable cached file per beat", () => {
    const plan = createVoicePlan(campaign, {
      provider: "system",
      model: "macos-say",
      voice: "Daniel",
      instructions: "Confident and direct.",
    });

    expect(plan.disclosure).toContain("synthetic");
    expect(plan.clips).toHaveLength(4);
    expect(plan.clips.map((clip) => clip.file)).toEqual([
      "audio/codex-campaign/hook.mp3",
      "audio/codex-campaign/build.mp3",
      "audio/codex-campaign/ship.mp3",
      "audio/codex-campaign/cta.mp3",
    ]);
    expect(plan.clips[0]).toMatchObject({ from: 0, durationInFrames: 90 });
  });
});
