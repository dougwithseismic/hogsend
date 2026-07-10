import { describe, expect, it } from "vitest";
import { isJourneySpec, journeySpecSchema } from "../schema.js";

const validSpec = {
  specVersion: 1,
  id: "winback-dormant",
  meta: {
    name: "Winback",
    enabled: true,
    trigger: { event: "user.dormant_30d" },
    entryLimit: "once_per_period",
    entryPeriod: { hours: 24 * 60 },
    suppress: { hours: 12 },
    exitOn: [{ event: "user.activated" }],
  },
  steps: [
    {
      id: "checkin",
      type: "send_email",
      template: "reactivation-checkin",
      subject: "Everything okay?",
    },
    { id: "wait-3d", type: "sleep", duration: { hours: 72 } },
    {
      id: "came-back",
      type: "branch",
      if: {
        type: "event",
        eventName: "user.activated",
        check: "exists",
        within: { hours: 72 },
      },
      yes: [{ id: "done", type: "end" }],
    },
    {
      id: "await-use",
      type: "wait_for_event",
      event: "feature.used",
      timeout: { hours: 168 },
    },
    {
      id: "used",
      type: "branch",
      if: { type: "wait_result", of: "await-use", fired: true },
      yes: [
        { id: "celebrate", type: "trigger_event", event: "winback.converted" },
      ],
      no: [
        {
          id: "final",
          type: "send_email",
          template: "reactivation-final-nudge",
          subject: "One last note",
        },
      ],
    },
  ],
};

describe("journeySpecSchema", () => {
  it("accepts a full valid spec (every step type)", () => {
    const parsed = journeySpecSchema.parse(validSpec);
    expect(parsed.id).toBe("winback-dormant");
    expect(parsed.steps).toHaveLength(5);
  });

  it("rejects an unknown step type", () => {
    const bad = {
      ...validSpec,
      steps: [{ id: "x", type: "send_carrier_pigeon" }],
    };
    expect(() => journeySpecSchema.parse(bad)).toThrow();
  });

  it("rejects a zero duration", () => {
    const bad = {
      ...validSpec,
      steps: [{ id: "nap", type: "sleep", duration: {} }],
    };
    expect(() => journeySpecSchema.parse(bad)).toThrow(/duration/);
  });

  it("rejects step ids that can't be durable labels", () => {
    const bad = {
      ...validSpec,
      steps: [
        {
          id: "has spaces!",
          type: "checkpoint",
        },
      ],
    };
    expect(() => journeySpecSchema.parse(bad)).toThrow();
  });

  it("rejects reserved step ids that collide with terminal graph nodes", () => {
    for (const id of ["start", "end-completed", "end-exited", "end-failed"]) {
      const bad = { ...validSpec, steps: [{ id, type: "checkpoint" }] };
      expect(() => journeySpecSchema.parse(bad), id).toThrow(/reserved/);
    }
  });

  it("rejects a wrong specVersion", () => {
    expect(() =>
      journeySpecSchema.parse({ ...validSpec, specVersion: 2 }),
    ).toThrow();
  });

  it("rejects meta missing required fields", () => {
    const { suppress: _suppress, ...metaWithoutSuppress } = validSpec.meta;
    expect(() =>
      journeySpecSchema.parse({ ...validSpec, meta: metaWithoutSuppress }),
    ).toThrow();
  });

  it("accepts nested composite conditions", () => {
    const spec = {
      ...validSpec,
      steps: [
        {
          id: "gate",
          type: "branch",
          if: {
            type: "composite",
            operator: "and",
            conditions: [
              {
                type: "property",
                property: "plan",
                operator: "eq",
                value: "pro",
              },
              {
                type: "composite",
                operator: "or",
                conditions: [
                  { type: "event", eventName: "feature.used", check: "exists" },
                  {
                    type: "property",
                    property: "vip",
                    operator: "eq",
                    value: true,
                  },
                ],
              },
            ],
          },
          yes: [],
        },
      ],
    };
    expect(() => journeySpecSchema.parse(spec)).not.toThrow();
  });
});

describe("isJourneySpec", () => {
  it("distinguishes specs from DefinedJourney-shaped objects", () => {
    expect(isJourneySpec(validSpec)).toBe(true);
    expect(isJourneySpec({ meta: { id: "x" }, task: {} })).toBe(false);
    expect(isJourneySpec(null)).toBe(false);
    expect(isJourneySpec("spec")).toBe(false);
  });
});
