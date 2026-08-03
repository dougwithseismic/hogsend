import { describe, expect, it } from "vitest";
import {
  sanitizeUserCodeInput,
  USER_CODE_LENGTH,
} from "@/src/lib/user-code-input";
import {
  generateUserCode,
  normalizeUserCode,
} from "@/src/services/cli-device-codes";

/**
 * The segmented code input on `/cli/approve` feeds every character — typed,
 * pasted, or prefilled from `?code=` — through `sanitizeUserCodeInput`. These
 * tests pin the three paths the UX depends on: the dashed paste (how the CLI
 * displays the code, therefore how it gets pasted), the undashed paste, and
 * the prefill, plus the excluded-character behaviour.
 */

describe("sanitizeUserCodeInput", () => {
  it("fills all eight boxes from a dashed paste — the form the CLI prints", () => {
    expect(sanitizeUserCodeInput("KS66-XZSM")).toBe("KS66XZSM");
  });

  it("accepts the undashed form too", () => {
    expect(sanitizeUserCodeInput("KS66XZSM")).toBe("KS66XZSM");
  });

  it("uppercases and ignores whitespace, matching the server's leniency", () => {
    expect(sanitizeUserCodeInput("  ks66 - xzsm\n")).toBe("KS66XZSM");
    expect(sanitizeUserCodeInput("\tK S 6 6 X Z S M ")).toBe("KS66XZSM");
  });

  it("refuses excluded alphabet characters instead of placing them", () => {
    // I, L, O, U, 0 and 1 are not in the code alphabet — a keystroke of one
    // must visibly not take, never silently become part of a submitted code.
    for (const char of ["I", "L", "O", "U", "0", "1", "i", "o"]) {
      expect(sanitizeUserCodeInput(char)).toBe("");
    }
    expect(sanitizeUserCodeInput("KS66-XZSO")).toBe("KS66XZS");
  });

  it("caps at eight characters", () => {
    expect(sanitizeUserCodeInput("KS66-XZSM-EXTRA9")).toHaveLength(
      USER_CODE_LENGTH,
    );
    expect(sanitizeUserCodeInput("KS66-XZSMKS66")).toBe("KS66XZSM");
  });

  it("passes a single valid keystroke through, either case", () => {
    expect(sanitizeUserCodeInput("k")).toBe("K");
    expect(sanitizeUserCodeInput("7")).toBe("7");
  });

  it("prefill path: a server-normalized code sanitizes to the same code the server accepts", () => {
    // `?code=` arrives already through `normalizeUserCode` (dashed); the boxes
    // strip the dash, and the joined value round-trips to the same code.
    for (let i = 0; i < 20; i += 1) {
      const dashed = generateUserCode();
      const boxes = sanitizeUserCodeInput(dashed);
      expect(boxes).toHaveLength(USER_CODE_LENGTH);
      expect(normalizeUserCode(boxes)).toBe(dashed);
    }
  });
});
