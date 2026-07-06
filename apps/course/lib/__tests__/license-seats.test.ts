import { describe, expect, it } from "vitest";
import { clampSeats, MAX_TEAM_SEATS, MIN_TEAM_SEATS } from "../license-seats";

describe("clampSeats", () => {
  it("passes through values inside the range", () => {
    expect(clampSeats(2)).toBe(2);
    expect(clampSeats(5)).toBe(5);
    expect(clampSeats(25)).toBe(25);
    expect(clampSeats("10")).toBe(10);
  });

  it("clamps below the minimum", () => {
    expect(clampSeats(1)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(0)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(-7)).toBe(MIN_TEAM_SEATS);
  });

  it("clamps above the maximum", () => {
    expect(clampSeats(26)).toBe(MAX_TEAM_SEATS);
    expect(clampSeats(10_000)).toBe(MAX_TEAM_SEATS);
  });

  it("truncates fractional counts", () => {
    expect(clampSeats(5.9)).toBe(5);
    expect(clampSeats("3.2")).toBe(3);
  });

  it("falls back to the minimum on junk input", () => {
    expect(clampSeats("banana")).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(null)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(undefined)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(Number.NaN)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats(Number.POSITIVE_INFINITY)).toBe(MIN_TEAM_SEATS);
    expect(clampSeats("")).toBe(MIN_TEAM_SEATS);
  });
});
