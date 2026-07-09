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
