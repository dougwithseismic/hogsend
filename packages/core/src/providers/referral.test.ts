import { describe, expect, it } from "vitest";
import { days, hours } from "../duration.js";
import { defineReferral } from "./referral.js";

const link = { destination: "https://app.example.com/join" };

describe("defineReferral", () => {
  it('defaults the id to "default" and the window to 30 days', () => {
    const def = defineReferral({ link });
    expect(def.id).toBe("default");
    expect(def.bindWindow).toEqual(days(30));
    expect(def.qualifyWhere).toBeUndefined();
  });

  it("keeps an explicit id, window and hooks", () => {
    const def = defineReferral({
      id: "invite",
      link,
      bindWindow: hours(48),
      beforeTouch: () => ({ ok: true }),
    });
    expect(def.id).toBe("invite");
    expect(def.bindWindow).toEqual(hours(48));
    expect(def.meta.beforeTouch).toBeTypeOf("function");
  });

  it("normalizes a builder-form qualify.where ONCE, at definition time", () => {
    // The function never runs per-user, so conditions stay introspectable data
    // everywhere downstream (registry, routes, Studio).
    const def = defineReferral({
      link,
      qualify: {
        event: "subscription.started",
        where: (b) => b.prop("value").gte(10),
      },
    });
    expect(def.qualifyWhere).toEqual([
      { type: "property", property: "value", operator: "gte", value: 10 },
    ]);
  });

  it("passes a declarative qualify.where through unchanged", () => {
    const where = [
      {
        type: "property" as const,
        property: "plan",
        operator: "eq" as const,
        value: "pro",
      },
    ];
    expect(
      defineReferral({ link, qualify: { event: "x", where } }).qualifyWhere,
    ).toEqual(where);
  });

  it("rejects an id that is not a legal discriminator", () => {
    // The id is a DB discriminator and a report query parameter.
    expect(() => defineReferral({ id: "in vite", link })).toThrow(/invalid/);
    expect(() => defineReferral({ id: "-lead", link })).toThrow(/invalid/);
    expect(() => defineReferral({ id: "a".repeat(65), link })).toThrow(
      /invalid/,
    );
  });

  it("rejects a non-http destination", () => {
    expect(() =>
      defineReferral({ link: { destination: "javascript:alert(1)" } }),
    ).toThrow(/http/);
    expect(() => defineReferral({ link: { destination: "/join" } })).toThrow(
      /invalid link.destination/,
    );
  });

  it("accepts a function destination", () => {
    const def = defineReferral({
      link: { destination: (r) => `https://app.example.com/${r.contactId}` },
    });
    expect(typeof def.meta.link.destination).toBe("function");
  });

  it("rejects a qualify step with no event", () => {
    // It could never fire, silently stranding every bound referee.
    expect(() => defineReferral({ link, qualify: { event: "" } })).toThrow(
      /qualify without an event/,
    );
  });

  it("rejects a non-positive bindWindow", () => {
    // A zero window rejects EVERY touch the instant it binds, so the program
    // looks wired and produces nothing.
    expect(() => defineReferral({ link, bindWindow: days(0) })).toThrow(
      /non-positive bindWindow/,
    );
  });
});
