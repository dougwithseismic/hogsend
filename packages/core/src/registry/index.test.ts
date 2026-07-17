import { describe, expect, it } from "vitest";
import type { JourneyMeta } from "../types/index.js";
import { JourneyRegistry } from "./index.js";

// DB-free unit test: JourneyRegistry.register() is pure. Fake journeys satisfy
// journeyMetaSchema (mirroring the fakeJourney shape in apps/api's
// enabled-journeys-validation.test.ts) so register() succeeds on the
// valid-subset path.
function fakeJourney(id: string, event = `${id}.triggered`): JourneyMeta {
  return {
    id,
    name: id,
    enabled: true,
    trigger: { event },
    entryLimit: "unlimited",
    suppress: {},
  } as unknown as JourneyMeta;
}

describe("JourneyRegistry.register duplicate-id guard", () => {
  it("throws (naming the id) when the same id is registered twice", () => {
    const registry = new JourneyRegistry();
    registry.register(fakeJourney("welcome-series"));

    expect(() => registry.register(fakeJourney("welcome-series"))).toThrow(
      /"welcome-series"/,
    );

    let message = "";
    try {
      registry.register(fakeJourney("welcome-series"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Journey id collision");
    expect(message).toContain('"welcome-series"');
  });

  it("registers distinct ids without throwing; count() reflects both", () => {
    const registry = new JourneyRegistry();
    expect(() => {
      registry.register(fakeJourney("welcome-series"));
      registry.register(fakeJourney("nps-followup"));
    }).not.toThrow();

    expect(registry.count()).toBe(2);
    expect(registry.has("welcome-series")).toBe(true);
    expect(registry.has("nps-followup")).toBe(true);
  });

  it("throws BEFORE the triggerIndex is corrupted by a duplicate", () => {
    // Both journeys share the SAME trigger event, so a silent last-wins would
    // double-populate triggerIndex. The guard must reject the second register
    // before that push, leaving exactly one journey routed to the event.
    const registry = new JourneyRegistry();
    const event = "signup.completed";
    registry.register(fakeJourney("dup-journey", event));

    expect(() => registry.register(fakeJourney("dup-journey", event))).toThrow(
      /Journey id collision/,
    );

    const routed = registry.getByTriggerEvent(event);
    expect(routed).toHaveLength(1);
    expect(routed[0]?.id).toBe("dup-journey");
  });
});

// ===========================================================================
// Impact-experiments round-trip suite (D0) — the strip-bug fix, pinned.
//
// journeyMetaSchema.parse runs inside register() and STRIPS unknown keys.
// Before D0 the schema omitted `category` AND `holdout`, so
// registry.get(id).holdout was silently undefined for EVERY journey — any
// registry-reading readout would have labeled every journey observational.
// This suite locks all five fields (the three new ones + the two previously
// missing) through the register() round-trip, plus format/bounds rejections.
// ===========================================================================

function impactMeta(
  id: string,
  overrides: Partial<JourneyMeta> = {},
): JourneyMeta {
  return {
    id,
    name: id,
    enabled: true,
    trigger: { event: `${id}.triggered` },
    entryLimit: "once",
    suppress: {},
    version: "2026-07-baseline",
    versionHash: "0123456789ab",
    goal: "revenue",
    category: "journey",
    holdout: { percent: 10, salt: "s1" },
    ...overrides,
  };
}

describe("journeyMetaSchema impact fields round-trip (D0)", () => {
  it("register() retains version, versionHash, goal, category, holdout", () => {
    const registry = new JourneyRegistry();
    registry.register(impactMeta("impact-full"));

    const stored = registry.get("impact-full");
    expect(stored).toBeDefined();
    expect(stored?.version).toBe("2026-07-baseline");
    expect(stored?.versionHash).toBe("0123456789ab");
    expect(stored?.goal).toBe("revenue");
    expect(stored?.category).toBe("journey");
    expect(stored?.holdout).toEqual({ percent: 10, salt: "s1" });
  });

  it("all five fields stay optional — a minimal meta still registers", () => {
    const registry = new JourneyRegistry();
    registry.register(fakeJourney("impact-minimal"));

    const stored = registry.get("impact-minimal");
    expect(stored).toBeDefined();
    expect(stored?.version).toBeUndefined();
    expect(stored?.versionHash).toBeUndefined();
    expect(stored?.goal).toBeUndefined();
    expect(stored?.category).toBeUndefined();
    expect(stored?.holdout).toBeUndefined();
  });

  it("keeps holdout percent LOOSE — clamped at evaluation, never boot", () => {
    // lib/holdout.ts clamps 0-50 at evaluation; a boot throw on a
    // clamped-but-legal value would be a regression (spec D0 schema note).
    const registry = new JourneyRegistry();
    registry.register(impactMeta("impact-loose", { holdout: { percent: 75 } }));
    expect(registry.get("impact-loose")?.holdout).toEqual({ percent: 75 });
  });

  it("rejects a versionHash that is not exactly 12 lowercase hex", () => {
    const registry = new JourneyRegistry();
    const bad = [
      "0123456789AB", // uppercase
      "0123456789a", // 11 chars
      "0123456789abc", // 13 chars
      "0123456789xz", // non-hex
    ];
    for (const versionHash of bad) {
      expect(() =>
        registry.register(
          impactMeta(`impact-hash-${versionHash}`, { versionHash }),
        ),
      ).toThrow(/versionHash/);
    }
    // Boundary: a valid 12-lowercase-hex hash registers and round-trips.
    registry.register(
      impactMeta("impact-hash-ok", { versionHash: "abcdef012345" }),
    );
    expect(registry.get("impact-hash-ok")?.versionHash).toBe("abcdef012345");
  });

  it("rejects an empty-string goal", () => {
    const registry = new JourneyRegistry();
    expect(() =>
      registry.register(impactMeta("impact-goal-empty", { goal: "" })),
    ).toThrow(/goal/);
  });

  it("rejects a 65-char version label (and empty); accepts 64", () => {
    const registry = new JourneyRegistry();
    expect(() =>
      registry.register(impactMeta("impact-v-65", { version: "v".repeat(65) })),
    ).toThrow(/version/);
    expect(() =>
      registry.register(impactMeta("impact-v-0", { version: "" })),
    ).toThrow(/version/);
    registry.register(impactMeta("impact-v-64", { version: "v".repeat(64) }));
    expect(registry.get("impact-v-64")?.version).toBe("v".repeat(64));
  });
});
