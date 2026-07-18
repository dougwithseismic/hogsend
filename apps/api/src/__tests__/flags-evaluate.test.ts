import { describe, expect, it } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { evaluateFlag } = await import("@hogsend/engine");

import type { EvaluableFlag } from "@hogsend/engine";

function boolFlag(overrides: Partial<EvaluableFlag> = {}): EvaluableFlag {
  return {
    key: "test-flag",
    enabled: true,
    type: "boolean",
    variants: [],
    defaultValue: false,
    targeting: [],
    rollout: 100,
    ...overrides,
  };
}

describe("evaluateFlag — disabled + empty targeting", () => {
  it("a disabled flag always serves defaultValue", () => {
    const flag = boolFlag({ enabled: false, defaultValue: false });
    expect(evaluateFlag(flag, { contactKey: "u1", properties: {} })).toBe(
      false,
    );
  });

  it("empty targeting means everyone matches (full rollout → true)", () => {
    const flag = boolFlag();
    for (const key of ["a", "b", "c", "d", "e"]) {
      expect(evaluateFlag(flag, { contactKey: key, properties: {} })).toBe(
        true,
      );
    }
  });
});

describe("evaluateFlag — targeting gate", () => {
  const flag = boolFlag({
    targeting: [
      { type: "property", property: "plan", operator: "eq", value: "pro" },
    ],
  });

  it("serves true when the property matches", () => {
    expect(
      evaluateFlag(flag, { contactKey: "u1", properties: { plan: "pro" } }),
    ).toBe(true);
  });

  it("serves defaultValue when the property does not match", () => {
    expect(
      evaluateFlag(flag, { contactKey: "u1", properties: { plan: "free" } }),
    ).toBe(false);
    // Missing property → no match → default.
    expect(evaluateFlag(flag, { contactKey: "u1", properties: {} })).toBe(
      false,
    );
  });
});

describe("evaluateFlag — rollout stickiness + distribution", () => {
  it("is sticky: the same contactKey yields the same result across calls", () => {
    const flag = boolFlag({ rollout: 50 });
    const first = evaluateFlag(flag, {
      contactKey: "sticky-user",
      properties: {},
    });
    for (let i = 0; i < 50; i++) {
      expect(
        evaluateFlag(flag, { contactKey: "sticky-user", properties: {} }),
      ).toBe(first);
    }
  });

  it("~rollout% of many distinct keys are on (30% ± 5)", () => {
    const flag = boolFlag({ rollout: 30 });
    let on = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (
        evaluateFlag(flag, { contactKey: `user-${i}`, properties: {} }) === true
      ) {
        on++;
      }
    }
    const pct = (on / N) * 100;
    expect(pct).toBeGreaterThan(25);
    expect(pct).toBeLessThan(35);
  });

  it("rollout 0 excludes everyone; rollout 100 includes everyone", () => {
    const zero = boolFlag({ rollout: 0 });
    const full = boolFlag({ rollout: 100 });
    let zeroOn = 0;
    let fullOn = 0;
    for (let i = 0; i < 1000; i++) {
      if (evaluateFlag(zero, { contactKey: `k-${i}`, properties: {} }) === true)
        zeroOn++;
      if (evaluateFlag(full, { contactKey: `k-${i}`, properties: {} }) === true)
        fullOn++;
    }
    expect(zeroOn).toBe(0);
    expect(fullOn).toBe(1000);
  });
});

describe("evaluateFlag — multivariate", () => {
  const flag: EvaluableFlag = {
    key: "mv-flag",
    enabled: true,
    type: "multivariate",
    variants: [
      { key: "control", value: "A", weight: 25 },
      { key: "variant", value: "B", weight: 75 },
    ],
    defaultValue: null,
    targeting: [],
    rollout: 100,
  };

  it("is sticky per contactKey", () => {
    const first = evaluateFlag(flag, { contactKey: "mv-user", properties: {} });
    for (let i = 0; i < 20; i++) {
      expect(
        evaluateFlag(flag, { contactKey: "mv-user", properties: {} }),
      ).toBe(first);
    }
  });

  it("distributes ~25/75 across many keys", () => {
    let a = 0;
    let b = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const v = evaluateFlag(flag, { contactKey: `mv-${i}`, properties: {} });
      if (v === "A") a++;
      else if (v === "B") b++;
    }
    expect(a + b).toBe(N);
    const aPct = (a / N) * 100;
    expect(aPct).toBeGreaterThan(20);
    expect(aPct).toBeLessThan(30);
  });

  it("outside the rollout serves defaultValue, not a variant", () => {
    const gated: EvaluableFlag = { ...flag, rollout: 0, defaultValue: "OFF" };
    for (let i = 0; i < 100; i++) {
      expect(
        evaluateFlag(gated, { contactKey: `g-${i}`, properties: {} }),
      ).toBe("OFF");
    }
  });
});
