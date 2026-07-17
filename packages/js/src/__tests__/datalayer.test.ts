import { describe, expect, it } from "vitest";
import {
  isSelfOrGtm,
  outboundEntry,
  pluckScalars,
  resolveInbound,
} from "../datalayer/index.js";

describe("outboundEntry", () => {
  it("prefixes the event and namespaces the payload under `hogsend`", () => {
    expect(outboundEntry("purchase", { plan: "pro", value: 49 })).toEqual({
      event: "hogsend.purchase",
      hogsend: { event: "purchase", properties: { plan: "pro", value: 49 } },
    });
  });

  it("carries an empty property bag verbatim", () => {
    expect(outboundEntry("checkout", {})).toEqual({
      event: "hogsend.checkout",
      hogsend: { event: "checkout", properties: {} },
    });
  });
});

describe("isSelfOrGtm", () => {
  it("flags hogsend.* and gtm.* as self/GTM", () => {
    expect(isSelfOrGtm("hogsend.purchase")).toBe(true);
    expect(isSelfOrGtm("gtm.load")).toBe(true);
    expect(isSelfOrGtm("gtm.js")).toBe(true);
  });

  it("passes through real events", () => {
    expect(isSelfOrGtm("sign_up")).toBe(false);
    expect(isSelfOrGtm("purchase")).toBe(false);
    // A substring match must NOT trigger — prefix only.
    expect(isSelfOrGtm("my_gtm.event")).toBe(false);
  });
});

describe("pluckScalars", () => {
  it("keeps scalars and null, drops the event key and nested shapes", () => {
    const out = pluckScalars({
      event: "sign_up",
      plan: "pro",
      seats: 5,
      trial: true,
      referrer: null,
      ecommerce: { items: [{ id: "a" }] },
      tags: ["x", "y"],
      cb: () => undefined,
      missing: undefined,
    });
    expect(out).toEqual({
      plan: "pro",
      seats: 5,
      trial: true,
      referrer: null,
    });
  });

  it("returns an empty bag when only the event key is present", () => {
    expect(pluckScalars({ event: "sign_up" })).toEqual({});
  });
});

describe("resolveInbound", () => {
  const allow = ["sign_up", "purchase"];

  it("captures an allowlisted entry with flat scalar props", () => {
    expect(
      resolveInbound(
        { event: "sign_up", plan: "pro", ecommerce: { x: 1 } },
        allow,
      ),
    ).toEqual({ event: "sign_up", properties: { plan: "pro" } });
  });

  it("drops a non-allowlisted entry", () => {
    expect(resolveInbound({ event: "scroll_depth" }, allow)).toBeNull();
  });

  it("ignores a non-string event (gtag arguments-object push)", () => {
    // `gtag('event', 'x')` pushes an arguments object: { 0: 'event', 1: 'x' }.
    const argsLike = { 0: "event", 1: "sign_up" } as Record<string, unknown>;
    expect(resolveInbound(argsLike, allow)).toBeNull();
  });

  it("applies the loop guard before any allowlist or map", () => {
    expect(resolveInbound({ event: "hogsend.purchase" }, allow)).toBeNull();
    expect(resolveInbound({ event: "gtm.load" }, allow)).toBeNull();
    // Even a map that would accept it cannot resurrect a guarded event.
    expect(
      resolveInbound({ event: "hogsend.purchase" }, allow, () => ({
        event: "purchase",
      })),
    ).toBeNull();
  });

  it("lets a map fully own the decision (rename + reshape)", () => {
    const map = (e: Record<string, unknown>) => ({
      event: "purchase",
      properties: { total: (e.value as number) * 2 },
    });
    expect(resolveInbound({ event: "checkout", value: 10 }, [], map)).toEqual({
      event: "purchase",
      properties: { total: 20 },
    });
  });

  it("lets a map drop an entry by returning null", () => {
    expect(resolveInbound({ event: "sign_up" }, allow, () => null)).toBeNull();
  });
});
