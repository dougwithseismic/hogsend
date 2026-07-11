import { describe, expect, it } from "vitest";
import { countSmsSegments } from "../segments.js";

describe("countSmsSegments", () => {
  it("counts a short GSM-7 body as one segment", () => {
    const r = countSmsSegments("Hello there");
    expect(r).toEqual({ segments: 1, encoding: "gsm7", units: 11 });
  });

  it("uses 160 as the single-segment GSM-7 boundary", () => {
    expect(countSmsSegments("a".repeat(160)).segments).toBe(1);
    expect(countSmsSegments("a".repeat(161)).segments).toBe(2); // 161 → 153-unit segments
  });

  it("counts GSM-7 extension chars as two units", () => {
    // "€" is in the extension table → 2 septets.
    const r = countSmsSegments("€");
    expect(r.encoding).toBe("gsm7");
    expect(r.units).toBe(2);
    expect(r.segments).toBe(1);
  });

  it("switches to UCS-2 for non-GSM characters", () => {
    const r = countSmsSegments("Hello 👋");
    expect(r.encoding).toBe("ucs2");
    expect(r.segments).toBe(1);
  });

  it("uses 70 as the single-segment UCS-2 boundary", () => {
    // "é" is GSM-7, so force UCS-2 with an emoji-free non-GSM char set is hard;
    // use a CJK char which is UCS-2.
    expect(countSmsSegments("好".repeat(70)).segments).toBe(1);
    expect(countSmsSegments("好".repeat(71)).segments).toBe(2); // 71 → 67-unit segments
  });

  it("never returns zero segments for an empty body", () => {
    expect(countSmsSegments("").segments).toBe(1);
  });
});
