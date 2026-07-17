import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOutbound,
  isSelfOrGtm,
  markOutbound,
  outboundEntry,
  pluckScalars,
  resolveInbound,
  resolveOutbound,
  startDataLayerBridge,
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

describe("resolveOutbound", () => {
  it("defaults to the namespaced hogsend.<name> entry", () => {
    expect(resolveOutbound("purchase", { value: 49 }, {})).toEqual({
      event: "hogsend.purchase",
      hogsend: { event: "purchase", properties: { value: 49 } },
    });
  });

  it("only mirrors events on the outbound allowlist", () => {
    const cfg = { events: ["purchase"] };
    expect(resolveOutbound("purchase", {}, cfg)).not.toBeNull();
    expect(resolveOutbound("inapp.item_seen", {}, cfg)).toBeNull();
  });

  it("lets a transform reshape the entry", () => {
    const entry = resolveOutbound(
      "purchase",
      { value: 49 },
      {
        transform: (event, props) => ({
          event: `hs_${event}`,
          value: props.value,
        }),
      },
    );
    expect(entry).toEqual({ event: "hs_purchase", value: 49 });
  });

  it("lets a transform drop an event by returning null", () => {
    expect(resolveOutbound("noisy", {}, { transform: () => null })).toBeNull();
  });

  it("applies the events filter before the transform", () => {
    const transform = vi.fn(() => ({ event: "x" }));
    expect(
      resolveOutbound("skipme", {}, { events: ["purchase"], transform }),
    ).toBeNull();
    expect(transform).not.toHaveBeenCalled();
  });
});

describe("outbound tag", () => {
  it("marks entries non-enumerably and detects them", () => {
    const entry = markOutbound({ event: "hogsend.x" });
    expect(isOutbound(entry)).toBe(true);
    expect(isOutbound({ event: "x" })).toBe(false);
    // Non-enumerable → invisible to GTM iteration and serialization.
    expect(Object.keys(entry)).toEqual(["event"]);
    expect(JSON.parse(JSON.stringify(entry))).toEqual({ event: "hogsend.x" });
  });
});

describe("startDataLayerBridge (window wiring)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a no-op under SSR (no window)", () => {
    // No window stubbed → returns a no-op teardown, never throws.
    expect(() =>
      startDataLayerBridge({
        config: { watch: { events: ["x"] } },
        capture: () => {},
        registerOutbound: () => {},
      })(),
    ).not.toThrow();
  });

  it("replays pre-existing allowlisted entries and pipes live pushes", () => {
    const captured: Array<{ event: string; props?: Record<string, unknown> }> =
      [];
    const dataLayer: Record<string, unknown>[] = [
      { event: "sign_up", plan: "pro", ecommerce: { x: 1 } }, // pre-existing
      { event: "page_view" }, // not allowlisted
    ];
    vi.stubGlobal("window", { dataLayer });

    const teardown = startDataLayerBridge({
      config: { watch: { events: ["sign_up", "purchase"] } },
      capture: (event, props) => captured.push({ event, props }),
      registerOutbound: () => {},
    });

    // Replay ingested only the allowlisted sign_up, flat scalars (no ecommerce).
    expect(captured).toEqual([{ event: "sign_up", props: { plan: "pro" } }]);

    // A live push of an allowlisted event flows through the wrapped push.
    dataLayer.push({ event: "purchase", total: 49 });
    expect(captured).toContainEqual({
      event: "purchase",
      props: { total: 49 },
    });

    teardown();
  });

  it("mirrors captured events outbound and never loops them back in", () => {
    const captured: string[] = [];
    const dataLayer: Record<string, unknown>[] = [];
    vi.stubGlobal("window", { dataLayer });

    let tap: ((e: string, p: Record<string, unknown>) => void) | undefined;
    const teardown = startDataLayerBridge({
      config: { push: true, watch: { events: ["sign_up"] } },
      capture: (event) => captured.push(event),
      registerOutbound: (fn) => {
        tap = fn;
      },
    });

    // Simulate the spine capturing an event → the outbound tap.
    tap?.("checkout", { plan: "pro" });
    expect(dataLayer.at(-1)).toEqual({
      event: "hogsend.checkout",
      hogsend: { event: "checkout", properties: { plan: "pro" } },
    });
    // The loop guard drops the echo — no re-ingestion.
    expect(captured).not.toContain("checkout");
    expect(captured).not.toContain("hogsend.checkout");

    teardown();
  });

  it("restores the original push on teardown", () => {
    const dataLayer: Record<string, unknown>[] = [];
    const origPush = dataLayer.push;
    vi.stubGlobal("window", { dataLayer });

    const teardown = startDataLayerBridge({
      config: { watch: { events: ["x"] } },
      capture: () => {},
      registerOutbound: () => {},
    });
    expect(dataLayer.push).not.toBe(origPush);
    teardown();
    expect(dataLayer.push).toBe(origPush);
  });

  it("creates the dataLayer array when the page has not defined one", () => {
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);

    const teardown = startDataLayerBridge({
      config: { push: true },
      capture: () => {},
      registerOutbound: (fn) => fn?.("hello", { a: 1 }),
    });
    expect(Array.isArray(win.dataLayer)).toBe(true);
    expect((win.dataLayer as unknown[])[0]).toEqual({
      event: "hogsend.hello",
      hogsend: { event: "hello", properties: { a: 1 } },
    });
    teardown();
  });

  it("mirrors only the outbound-allowlisted events", () => {
    const dataLayer: Record<string, unknown>[] = [];
    vi.stubGlobal("window", { dataLayer });

    let tap: ((e: string, p: Record<string, unknown>) => void) | undefined;
    const teardown = startDataLayerBridge({
      config: { push: { events: ["purchase"] } },
      capture: () => {},
      registerOutbound: (fn) => {
        tap = fn;
      },
    });

    tap?.("inapp.item_seen", {}); // not on the outbound allowlist → skipped
    tap?.("purchase", { value: 49 });
    expect(dataLayer).toHaveLength(1);
    expect(dataLayer[0]).toMatchObject({ event: "hogsend.purchase" });

    teardown();
  });

  it("a transform that renames to a watched event still cannot loop back in", () => {
    const captured: string[] = [];
    const dataLayer: Record<string, unknown>[] = [];
    vi.stubGlobal("window", { dataLayer });

    let tap: ((e: string, p: Record<string, unknown>) => void) | undefined;
    const teardown = startDataLayerBridge({
      config: {
        // Outbound renames `checkout` → `purchase` (no hogsend. prefix)…
        push: { transform: (event) => ({ event: "purchase", from: event }) },
        // …and inbound watches `purchase`. The tag guard must still block it.
        watch: { events: ["purchase"] },
      },
      capture: (event) => captured.push(event),
      registerOutbound: (fn) => {
        tap = fn;
      },
    });

    tap?.("checkout", {});
    expect(dataLayer.at(-1)).toMatchObject({
      event: "purchase",
      from: "checkout",
    });
    expect(captured).not.toContain("purchase"); // no loop-back ingestion

    teardown();
  });
});
