/**
 * A tiny module-level event bus that decouples LIVE flow pulses from React
 * Flow's store (P4).
 *
 * The CRITICAL constraint of the control room is reconcile identity: an edge
 * object must stay `Object.is`-stable across polls or its CSS animations
 * restart (see flow-canvas `reconcile`). A live pulse is therefore NOT edge
 * data — it is transient, per-edge local state. This bus lets `flow-view`
 * publish a pulse by edge id and lets exactly ONE `flow-edge` (the one that
 * subscribed to that id) react, so a single edge re-renders per transition
 * instead of the whole graph.
 *
 * No React, no context, no re-subscription churn — a plain `Map<id, Set<cb>>`.
 */

export interface PulsePayload {
  /** The transition's acquisition lane (for pulse colour), or null. */
  lane: string | null;
}

type PulseCallback = (payload: PulsePayload) => void;

const subscribers = new Map<string, Set<PulseCallback>>();

/** Subscribe to pulses for one edge id. Returns an unsubscribe fn. */
export function subscribe(edgeId: string, cb: PulseCallback): () => void {
  let set = subscribers.get(edgeId);
  if (!set) {
    set = new Set();
    subscribers.set(edgeId, set);
  }
  set.add(cb);
  return () => {
    const current = subscribers.get(edgeId);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) subscribers.delete(edgeId);
  };
}

/** Fan a pulse out to every subscriber of one edge id (no-op if none). */
export function publish(edgeId: string, payload: PulsePayload): void {
  const set = subscribers.get(edgeId);
  if (!set) return;
  for (const cb of set) cb(payload);
}

export const particleBus = { subscribe, publish };
