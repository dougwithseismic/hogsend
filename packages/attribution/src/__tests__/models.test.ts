import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MODELS,
  type AttributionTouchpoint,
  computeAllModels,
  computeCredits,
} from "../index.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_780_000_000_000;

/** click(campaign) → email click → sms click → lead form, one/day. */
const PATH: AttributionTouchpoint[] = [
  { id: "a", event: "campaign.arrived", channel: "campaign", occurredAt: T0 },
  {
    id: "b",
    event: "email.link_clicked",
    channel: "email",
    occurredAt: T0 + 1 * DAY,
  },
  {
    id: "c",
    event: "sms.link_clicked",
    channel: "sms",
    occurredAt: T0 + 2 * DAY,
  },
  {
    id: "d",
    event: "lead.submitted",
    channel: "form",
    occurredAt: T0 + 3 * DAY,
  },
];
const OPTS = { conversionAt: T0 + 10 * DAY };

const weightOf = (credits: { touchpointId: string; weight: number }[]) =>
  Object.fromEntries(credits.map((c) => [c.touchpointId, c.weight]));

describe("attribution models", () => {
  it("every model's weights sum to 1 on any non-empty path; empty path yields none", () => {
    for (const model of ATTRIBUTION_MODELS) {
      const sum = computeCredits(model, PATH, OPTS).reduce(
        (s, c) => s + c.weight,
        0,
      );
      expect(sum).toBeCloseTo(1, 9);
      expect(computeCredits(model, [], OPTS)).toEqual([]);
      // Single-touch path: that touch gets everything.
      const solo = computeCredits(
        model,
        [PATH[0] as AttributionTouchpoint],
        OPTS,
      );
      expect(solo).toEqual([{ touchpointId: "a", weight: 1 }]);
    }
  });

  it("first / last / lastNonDirect pick the right touch", () => {
    expect(computeCredits("first", PATH, OPTS)).toEqual([
      { touchpointId: "a", weight: 1 },
    ]);
    expect(computeCredits("last", PATH, OPTS)).toEqual([
      { touchpointId: "d", weight: 1 },
    ]);
    // Skips the form submit (the goal line, not the driver) → sms click.
    expect(computeCredits("lastNonDirect", PATH, OPTS)).toEqual([
      { touchpointId: "c", weight: 1 },
    ]);
    // All-excluded path falls back to plain last.
    const onlyForm = PATH.filter((t) => t.channel === "form");
    expect(computeCredits("lastNonDirect", onlyForm, OPTS)).toEqual([
      { touchpointId: "d", weight: 1 },
    ]);
  });

  it("linear splits evenly; timeDecay favors recency with the configured half-life", () => {
    const linear = weightOf(computeCredits("linear", PATH, OPTS));
    expect(linear.a).toBeCloseTo(0.25, 9);

    const decay = weightOf(
      computeCredits("timeDecay", PATH, {
        conversionAt: T0 + 3 * DAY,
        halfLifeDays: 1,
      }),
    );
    // One-day half-life, touches 3/2/1/0 days old → raw 1/8,1/4,1/2,1.
    expect((decay.d as number) / (decay.c as number)).toBeCloseTo(2, 6);
    expect((decay.d as number) / (decay.a as number)).toBeCloseTo(8, 6);
  });

  it("positionU: 40/20-split/40; two touches split evenly", () => {
    const u = weightOf(computeCredits("positionU", PATH, OPTS));
    expect(u.a).toBeCloseTo(0.4, 9);
    expect(u.d).toBeCloseTo(0.4, 9);
    expect(u.b).toBeCloseTo(0.1, 9);
    expect(u.c).toBeCloseTo(0.1, 9);
    const two = weightOf(computeCredits("positionU", PATH.slice(0, 2), OPTS));
    expect(two.a).toBeCloseTo(0.5, 9);
    expect(two.b).toBeCloseTo(0.5, 9);
  });

  it("positionW anchors first + lead + last at 30 each, middles share 10", () => {
    // Path where the lead form is NOT the last touch.
    const path: AttributionTouchpoint[] = [
      ...PATH,
      {
        id: "e",
        event: "email.link_clicked",
        channel: "email",
        occurredAt: T0 + 4 * DAY,
      },
    ];
    const w = weightOf(computeCredits("positionW", path, OPTS));
    expect(w.a).toBeCloseTo(0.3, 9); // first
    expect(w.d).toBeCloseTo(0.3, 9); // lead.submitted
    expect(w.e).toBeCloseTo(0.3, 9); // last
    expect((w.b as number) + (w.c as number)).toBeCloseTo(0.1, 9);
    // No form touch anywhere → two anchors pool the mass (normalized).
    const noLead = path.filter((t) => t.channel !== "form");
    const w2 = weightOf(computeCredits("positionW", noLead, OPTS));
    expect(w2.a).toBeCloseTo(w2.e as number, 9);
  });

  it("blended averages its parts and computeAllModels covers every model", () => {
    const blended = weightOf(computeCredits("blended", PATH, OPTS));
    const parts = ["linear", "timeDecay", "positionU"] as const;
    const manual: Record<string, number> = {};
    for (const part of parts) {
      for (const credit of computeCredits(part, PATH, OPTS)) {
        manual[credit.touchpointId] =
          (manual[credit.touchpointId] ?? 0) + credit.weight / parts.length;
      }
    }
    for (const t of PATH) {
      expect(blended[t.id]).toBeCloseTo(manual[t.id] as number, 9);
    }

    const all = computeAllModels(PATH, OPTS);
    expect(Object.keys(all).sort()).toEqual([...ATTRIBUTION_MODELS].sort());
  });
});
