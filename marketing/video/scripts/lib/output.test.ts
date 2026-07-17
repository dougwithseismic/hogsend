import { describe, expect, it } from "vitest";
import { getDefaultOutputRoot, getRenderJobs } from "./output";

describe("campaign render outputs", () => {
  it("defaults to the shared marketing out folder", () => {
    expect(
      getDefaultOutputRoot("/repo/marketing/video", "codex-campaign"),
    ).toBe("/repo/marketing/out/videos/codex-campaign");
  });

  it("maps every social format to a composition and stable filename", () => {
    expect(getRenderJobs("/tmp/output")).toEqual([
      {
        format: "landscape",
        composition: "codex-campaign-169",
        mp4: "/tmp/output/codex-campaign-landscape.mp4",
        webm: "/tmp/output/codex-campaign-landscape.webm",
        poster: "/tmp/output/codex-campaign-landscape-poster.png",
      },
      {
        format: "vertical",
        composition: "codex-campaign-916",
        mp4: "/tmp/output/codex-campaign-vertical.mp4",
        webm: "/tmp/output/codex-campaign-vertical.webm",
        poster: "/tmp/output/codex-campaign-vertical-poster.png",
      },
      {
        format: "square",
        composition: "codex-campaign-11",
        mp4: "/tmp/output/codex-campaign-square.mp4",
        webm: "/tmp/output/codex-campaign-square.webm",
        poster: "/tmp/output/codex-campaign-square-poster.png",
      },
    ]);
  });
});
