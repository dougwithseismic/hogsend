/**
 * A ~40-line external store with `Object.is` bailout, the reactive backbone for
 * `useSyncExternalStore` selector subscriptions in `@hogsend/react`. No
 * zustand, no context-value churn.
 */

/** A patch is either a partial slice merge or a full-state updater. */
export type Patch<S> = Partial<S> | ((prev: S) => S);

/** The minimal store contract consumed by surfaces and React hooks. */
export interface Store<S> {
  /** Current snapshot (stable reference between mutations). */
  getSnapshot(): S;
  /**
   * Apply a patch. A function patch must return the next full state; an object
   * patch is shallow-merged. Bails out (no notify) when the result is
   * reference-equal to the current state.
   */
  setState(patch: Patch<S>): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

/** Create an external store seeded with `initial`. */
export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    setState: (patch) => {
      const next =
        typeof patch === "function" ? patch(state) : { ...state, ...patch };
      if (Object.is(next, state)) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
