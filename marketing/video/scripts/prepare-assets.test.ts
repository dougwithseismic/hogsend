import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const videoRoot = resolve(import.meta.dirname, "..");

describe("product screenshot assets", () => {
  it("copies every approved Kinetic Overdrive screen", () => {
    execFileSync(process.execPath, ["scripts/prepare-assets.mjs"], {
      cwd: videoRoot,
    });

    for (const file of [
      "overview",
      "journeys",
      "contacts",
      "campaigns",
      "sends",
    ]) {
      const output = resolve(videoRoot, `public/images/studio/${file}.png`);
      expect(statSync(output).size).toBeGreaterThan(10_000);
    }
  });
});
