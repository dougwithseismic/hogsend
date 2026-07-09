import { describe, expect, it } from "vitest";
import type { JourneyMeta } from "../../types/journey.js";
import { JourneyRegistry } from "../index.js";

function makeMeta(id: string, name = id): JourneyMeta {
  return {
    id,
    name,
    enabled: true,
    trigger: { event: "user.created" },
    entryLimit: "once",
    suppress: { hours: 1 },
  };
}

describe("JourneyRegistry.register", () => {
  it("registers and retrieves a journey by id", () => {
    const reg = new JourneyRegistry();
    reg.register(makeMeta("welcome", "Welcome"));
    expect(reg.get("welcome")?.name).toBe("Welcome");
    expect(reg.has("welcome")).toBe(true);
    expect(reg.count()).toBe(1);
  });

  it("throws on a duplicate journey id, naming both journeys", () => {
    const reg = new JourneyRegistry();
    reg.register(makeMeta("welcome", "Welcome"));
    expect(() => reg.register(makeMeta("welcome", "Welcome v2"))).toThrow(
      /Duplicate journey id "welcome"/,
    );
    // The error message surfaces the prior journey's name so the author knows
    // which two journeys collided.
    expect(() => reg.register(makeMeta("welcome", "Welcome v2"))).toThrow(
      /Already registered: "Welcome"/,
    );
  });

  it("does not mutate the trigger index when a duplicate throws", () => {
    const reg = new JourneyRegistry();
    reg.register(makeMeta("welcome"));
    // This throw must leave triggerIndex consistent (one entry for the event).
    expect(() => reg.register(makeMeta("welcome"))).toThrow();
    expect(reg.getByTriggerEvent("user.created")).toHaveLength(1);
  });

  it("indexes journeys by trigger event", () => {
    const reg = new JourneyRegistry();
    reg.register(makeMeta("a"));
    reg.register(makeMeta("b"));
    expect(reg.getByTriggerEvent("user.created")).toHaveLength(2);
    expect(reg.getByTriggerEvent("user.deleted")).toHaveLength(0);
  });
});
