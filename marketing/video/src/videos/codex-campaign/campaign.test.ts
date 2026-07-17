import { describe, expect, it } from "vitest";
import { campaign, validateCampaign } from "./campaign";

describe("Codex campaign manifest", () => {
  it("is exactly 15 seconds and hooks within three seconds", () => {
    expect(campaign.fps).toBe(30);
    expect(campaign.durationInFrames).toBe(450);
    expect(campaign.beats[0]).toMatchObject({
      id: "hook",
      from: 0,
      durationInFrames: 90,
    });
    expect(() => validateCampaign(campaign)).not.toThrow();
  });

  it("covers the full timeline without gaps or overlaps", () => {
    const ranges = campaign.beats.map((beat) => [
      beat.from,
      beat.from + beat.durationInFrames,
    ]);
    expect(ranges).toEqual([
      [0, 90],
      [90, 250],
      [250, 390],
      [390, 450],
    ]);
  });

  it("uses plain customer-marketing language", () => {
    const copy = campaign.beats.map((beat) => beat.caption).join(" ");
    expect(copy).toContain("Stop chasing customers by hand.");
    expect(copy).toContain("Tell Codex what should happen.");
    expect(copy).toContain("ships it with your product");
    expect(copy.toLowerCase()).not.toContain("lifecycle");
  });
});
