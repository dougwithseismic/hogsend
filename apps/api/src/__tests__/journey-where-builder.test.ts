import { days, hours, JourneyRegistry } from "@hogsend/core";
import { defineJourney } from "@hogsend/engine";
import { describe, expect, it } from "vitest";
import { detractorRescue } from "../journeys/detractor-rescue.js";

// The `where` BUILDER form: `where: (b) => b.prop("score").lte(6)` resolves
// ONCE at defineJourney time to the byte-identical PropertyCondition data the
// declarative form produces. Downstream (registry zod parse, checkExits,
// admin routes, Studio) only ever sees plain data.

const baseMeta = {
  name: "Test",
  enabled: true,
  entryLimit: "once" as const,
  suppress: hours(1),
};

describe("defineJourney — where builder normalization", () => {
  it("resolves a single-condition builder fn to PropertyCondition[]", () => {
    const journey = defineJourney({
      meta: {
        ...baseMeta,
        id: "wb-single",
        trigger: {
          event: "nps.submitted",
          where: (b) => b.prop("score").lte(6),
        },
      },
      run: async () => {},
    });

    expect(journey.meta.trigger.where).toEqual([
      { type: "property", property: "score", operator: "lte", value: 6 },
    ]);
  });

  it("resolves a multi-condition builder fn (array return, AND-ed)", () => {
    const journey = defineJourney({
      meta: {
        ...baseMeta,
        id: "wb-multi",
        trigger: {
          event: "checkout.abandoned",
          where: (b) => [
            b.prop("plan").eq("pro"),
            b.prop("cartValue").gte(100),
          ],
        },
      },
      run: async () => {},
    });

    expect(journey.meta.trigger.where).toEqual([
      { type: "property", property: "plan", operator: "eq", value: "pro" },
      { type: "property", property: "cartValue", operator: "gte", value: 100 },
    ]);
  });

  it("normalizes builder fns in exitOn while leaving plain exits alone", () => {
    const journey = defineJourney({
      meta: {
        ...baseMeta,
        id: "wb-exit",
        trigger: { event: "trial.started" },
        exitOn: [
          { event: "user.deleted" },
          {
            event: "subscription.created",
            where: (b) => b.prop("plan").eq("pro"),
          },
        ],
      },
      run: async () => {},
    });

    expect(journey.meta.exitOn).toEqual([
      { event: "user.deleted" },
      {
        event: "subscription.created",
        where: [
          { type: "property", property: "plan", operator: "eq", value: "pro" },
        ],
      },
    ]);
  });

  it("passes the declarative array form through untouched", () => {
    const where = [
      {
        type: "property" as const,
        property: "plan",
        operator: "eq" as const,
        value: "pro",
      },
    ];
    const journey = defineJourney({
      meta: {
        ...baseMeta,
        id: "wb-declarative",
        trigger: { event: "user.created", where },
      },
      run: async () => {},
    });

    expect(journey.meta.trigger.where).toEqual(where);
  });

  it("produces meta the registry's zod parse accepts", () => {
    const journey = defineJourney({
      meta: {
        ...baseMeta,
        id: "wb-registry",
        entryLimit: "once_per_period",
        entryPeriod: days(30),
        trigger: {
          event: "nps.detractor",
          where: (b) => b.prop("score").lte(3),
        },
      },
      run: async () => {},
    });

    const registry = new JourneyRegistry();
    expect(() => registry.register(journey.meta)).not.toThrow();
    expect(registry.get("wb-registry")?.trigger.where).toEqual([
      { type: "property", property: "score", operator: "lte", value: 3 },
    ]);
  });

  it("dogfood: detractor-rescue ships normalized builder conditions", () => {
    expect(detractorRescue.meta.trigger.where).toEqual([
      { type: "property", property: "score", operator: "lte", value: 3 },
    ]);
  });
});
