import { describe, expect, it } from "vitest";
import { CAMPAIGN_SHOTS, getCampaignShot } from "./edit";

describe("Kinetic Overdrive campaign edit", () => {
  it("defines the approved contiguous 18-shot edit", () => {
    expect(CAMPAIGN_SHOTS).toHaveLength(18);
    expect(CAMPAIGN_SHOTS.map(({ from, to }) => [from, to])).toEqual([
      [0, 12],
      [12, 32],
      [32, 54],
      [54, 76],
      [76, 96],
      [96, 122],
      [122, 148],
      [148, 174],
      [174, 204],
      [204, 232],
      [232, 260],
      [260, 290],
      [290, 314],
      [314, 338],
      [338, 364],
      [364, 392],
      [392, 420],
      [420, 450],
    ]);
  });

  it("resolves boundary frames deterministically", () => {
    expect(getCampaignShot(0).id).toBe("stop");
    expect(getCampaignShot(75).id).toBe("by-hand");
    expect(getCampaignShot(449).id).toBe("cta");
  });

  it("clamps frames outside the composition", () => {
    expect(getCampaignShot(-1).id).toBe("stop");
    expect(getCampaignShot(450).id).toBe("cta");
  });
});
