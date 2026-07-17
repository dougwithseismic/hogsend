import { describe, expect, it } from "vitest";
import { getSceneState } from "./scene-state";

describe("Codex campaign scene state", () => {
  it.each([
    [0, "hook"],
    [89, "hook"],
    [90, "build"],
    [249, "build"],
    [250, "ship"],
    [389, "ship"],
    [390, "cta"],
    [449, "cta"],
  ] as const)("maps frame %i to %s", (frame, beat) => {
    expect(getSceneState(frame).beat).toBe(beat);
  });

  it("drives the frame and thermal field deterministically", () => {
    expect(getSceneState(0)).toMatchObject({
      lineProgress: 0,
      thermalMix: 0.5,
    });
    expect(getSceneState(30).lineProgress).toBe(1);
    expect(getSceneState(450)).toEqual(getSceneState(450));
  });
});
