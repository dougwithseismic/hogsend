/**
 * GTM/GA4 `dataLayer` bridge. Two opt-in directions:
 *   • outbound — every SDK-captured event is pushed to `window.dataLayer` as
 *     `{ event: "hogsend.<name>", hogsend: { event, properties } }`.
 *   • inbound  — an explicit allowlist of `dataLayer` events is piped into the
 *     capture spine, so existing GTM instrumentation can trigger journeys.
 *
 * The allowlist / loop-guard / scalar-filter logic is pure (node-testable);
 * only {@link startDataLayerBridge} touches `window`.
 */

import type {
  DataLayerConfig,
  DataLayerEntry,
  DataLayerInbound,
  DataLayerMapFn,
  Properties,
} from "../types.js";

/** Outbound prefix. Fixed (not configurable) so the loop guard stays trivial. */
export const OUTBOUND_PREFIX = "hogsend.";

/** Build the outbound dataLayer entry for a captured event. */
export function outboundEntry(
  name: string,
  properties: Properties,
): DataLayerEntry {
  return {
    event: `${OUTBOUND_PREFIX}${name}`,
    hogsend: { event: name, properties },
  };
}

/**
 * The hard loop guard: an event Hogsend itself put on the dataLayer, or one of
 * GTM's own `gtm.*` lifecycle events, is never ingested — regardless of the
 * allowlist or a `map`. Prevents an outbound→inbound echo from looping.
 */
export function isSelfOrGtm(eventName: string): boolean {
  return eventName.startsWith(OUTBOUND_PREFIX) || eventName.startsWith("gtm.");
}

/**
 * Copy top-level own-enumerable SCALAR properties (string/number/boolean/null),
 * dropping the `event` key and any nested object/array (e.g. GA4 `ecommerce`) —
 * those need an explicit `map`. Keeps the default inbound payload flat + safe.
 */
export function pluckScalars(entry: DataLayerEntry): Properties {
  const out: Properties = {};
  for (const key of Object.keys(entry)) {
    if (key === "event") continue;
    const v = entry[key];
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Decide whether a raw dataLayer entry should be captured, and as what. Order:
 *   1. `entry.event` must be a string (skips gtag()'s arguments-object pushes).
 *   2. loop guard — `hogsend.*` / `gtm.*` never ingest, even with a `map`.
 *   3. a `map` (when set) fully owns the decision (its return, or null to drop).
 *   4. otherwise allowlist membership + flat scalar properties.
 */
export function resolveInbound(
  entry: DataLayerEntry,
  allowlist: readonly string[],
  map?: DataLayerMapFn,
): DataLayerInbound | null {
  const name = entry.event;
  if (typeof name !== "string") return null;
  if (isSelfOrGtm(name)) return null;
  if (map) return map(entry);
  if (!allowlist.includes(name)) return null;
  return { event: name, properties: pluckScalars(entry) };
}

/** Options for {@link startDataLayerBridge}. */
export interface StartDataLayerBridgeOptions {
  config: DataLayerConfig;
  /** Pipe an inbound event into the spine. */
  capture: (event: string, properties?: Properties) => void;
  /**
   * Install (or, with `undefined`, clear) the outbound tap — the spine's
   * `onCapture` hook the client owns. Called only when `config.push` is set.
   */
  registerOutbound: (
    tap: ((event: string, properties: Properties) => void) | undefined,
  ) => void;
}

/**
 * Wire the bridge against `window`. Returns a teardown that restores the
 * original `dataLayer.push` (only if still ours) and clears the outbound tap.
 * A no-op (and no-op teardown) under SSR.
 */
export function startDataLayerBridge(
  opts: StartDataLayerBridgeOptions,
): () => void {
  if (typeof window === "undefined") return () => {};
  const { config, capture, registerOutbound } = opts;

  const name = config.name ?? "dataLayer";
  const w = window as unknown as Record<string, unknown>;
  // GTM's dataLayer is always an array; reuse an existing one, but never trust a
  // non-array value on that global (a `.slice()`/`.push` on it would throw).
  const existing = w[name];
  const arr: DataLayerEntry[] = Array.isArray(existing) ? existing : [];
  w[name] = arr;

  const teardowns: Array<() => void> = [];

  // Outbound: push every captured event onto the dataLayer.
  if (config.push) {
    registerOutbound((event, properties) => {
      arr.push(outboundEntry(event, properties));
    });
    teardowns.push(() => registerOutbound(undefined));
  }

  // Inbound: wrap push (preserving the original) + replay pre-existing entries.
  if (config.watch) {
    const allowlist = config.watch.events ?? [];
    const map = config.watch.map;
    const handle = (entry: unknown): void => {
      if (!entry || typeof entry !== "object") return;
      const resolved = resolveInbound(entry as DataLayerEntry, allowlist, map);
      if (resolved) capture(resolved.event, resolved.properties);
    };

    // Snapshot BEFORE wrapping; `slice()` + the reassignment run back-to-back
    // with no await, so on single-threaded JS nothing can push between them —
    // the snapshot holds only pre-wrap entries and live pushes hit the wrapper.
    const snapshot = arr.slice();
    const origPush = arr.push;
    const wrapped = (...items: DataLayerEntry[]): number => {
      for (const it of items) handle(it);
      return origPush.apply(arr, items);
    };
    arr.push = wrapped as typeof arr.push;
    teardowns.push(() => {
      if (arr.push === (wrapped as typeof arr.push)) arr.push = origPush;
    });

    for (const it of snapshot) handle(it);
  }

  return () => {
    for (const t of teardowns.splice(0)) t();
  };
}
