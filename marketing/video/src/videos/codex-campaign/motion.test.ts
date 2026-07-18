import { describe, expect, it } from "vitest";
import { directionalOffset, impactFlash, snapZoom } from "./motion";

describe("Kinetic Overdrive motion", () => {
  it("settles a snap zoom deterministically", () => {
    expect(snapZoom(0, 30, 1.35)).toBeCloseTo(1, 4);
    expect(snapZoom(30, 30, 1.35)).toBeCloseTo(1.35, 4);
    expect(snapZoom(60, 30, 1.35)).toBeCloseTo(1.35, 4);
  });

  it("limits an impact flash to two frames", () => {
    expect(impactFlash(0)).toBe(1);
    expect(impactFlash(1)).toBe(1);
    expect(impactFlash(2)).toBe(0);
    expect(impactFlash(3)).toBe(0);
  });

  it("moves into place from the requested direction", () => {
    expect(directionalOffset(0, 30, -1)).toBeLessThan(0);
    expect(directionalOffset(0, 30, 1)).toBeGreaterThan(0);
    expect(directionalOffset(30, 30, -1)).toBe(0);
  });
});
