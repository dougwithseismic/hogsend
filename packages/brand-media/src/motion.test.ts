import { describe, expect, it } from "vitest";
import { easeOutCubic, progress, windowedProgress } from "./motion";

describe("frame-derived motion", () => {
  it("clamps progress outside its frame range", () => {
    expect(progress(9, 10, 20)).toBe(0);
    expect(progress(20, 10, 20)).toBe(0.5);
    expect(progress(30, 10, 20)).toBe(1);
    expect(progress(99, 10, 20)).toBe(1);
  });

  it("applies a stable cubic ease", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("enters, holds, and exits without a wall clock", () => {
    expect(windowedProgress(0, 10, 20, 10)).toBe(0);
    expect(windowedProgress(15, 10, 20, 10)).toBe(0.5);
    expect(windowedProgress(25, 10, 20, 10)).toBe(1);
    expect(windowedProgress(35, 10, 20, 10)).toBe(0.5);
    expect(windowedProgress(40, 10, 20, 10)).toBe(0);
  });
});
