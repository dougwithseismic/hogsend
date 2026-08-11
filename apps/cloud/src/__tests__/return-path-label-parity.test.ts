import { describe, expect, it } from "vitest";
// Relative SOURCE import, not a package import: `@hogsend/core` is not a
// declared dependency of the control plane (and should not become one for a
// test's sake). The parity below can only be asserted where BOTH copies are
// reachable — which is exactly here and nowhere else in the repo, since core
// cannot import from an app. The core-side test only guards its own copy
// against accidental edits; THIS file is the real cross-copy pin.
import {
  normalizeReturnPathLabel,
  RETURN_PATH_LABEL_PATTERN,
} from "../../../../packages/core/src/providers/domains";
import {
  assertMailFromLabel,
  InvalidMailFromLabelError,
  MAIL_FROM_LABEL_PATTERN,
} from "../lib/sending-domains";

describe("return-path label rule parity (control plane ↔ @hogsend/core)", () => {
  it("the two patterns are byte-identical", () => {
    // The engine validates with the core rule BEFORE relaying (PRD 20); the
    // control plane re-validates with its own copy (PRD 15). If they drift, a
    // label one side accepts becomes the other side's 400 — or worse, a
    // published record the engine said was impossible. Whoever edits either
    // copy must edit both, and this is the test that says so.
    expect(MAIL_FROM_LABEL_PATTERN.source).toBe(
      RETURN_PATH_LABEL_PATTERN.source,
    );
    expect(MAIL_FROM_LABEL_PATTERN.flags).toBe(RETURN_PATH_LABEL_PATTERN.flags);
  });

  it("the two validators agree on behavior, not just on the regex", () => {
    // Same normalization (trim + lowercase) on the way in…
    for (const label of ["notifications", " Notifications ", "x-1", "a"]) {
      expect(assertMailFromLabel(label)).toBe(normalizeReturnPathLabel(label));
    }
    // …and the same refusals: core answers null, the control plane throws.
    for (const bad of ["-x", "x-", "has.dot", "", "a".repeat(64)]) {
      expect(normalizeReturnPathLabel(bad)).toBeNull();
      expect(() => assertMailFromLabel(bad)).toThrow(InvalidMailFromLabelError);
    }
  });
});
