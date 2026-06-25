"use client";

/**
 * `useStoreSelector(store, selector)` — binds a component to a SLICE of the
 * external store via `useSyncExternalStore`. A component re-renders only when
 * its selected slice changes (`Object.is` bailout), never on unrelated store
 * mutations and never from context-value churn.
 *
 * MANDATORY authoring rule: the selector MUST return a SCALAR or a STABLE
 * REFERENCE. A selector that builds a fresh object/array each call (e.g.
 * `s => s.items.filter(...)`) makes `useSyncExternalStore` infinite-loop
 * ("getSnapshot should be cached"). Derive collections from a stable slice,
 * never inside the selector.
 */

import type { Store } from "@hogsend/js";
import { useSyncExternalStore } from "react";

/** Subscribe to a slice of an external store. */
export function useStoreSelector<S, T>(
  store: Store<S>,
  selector: (state: S) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    // getServerSnapshot — same selector, SSR-safe (no client-only globals
    // read here; the store seeds an identity slice synchronously).
    () => selector(store.getSnapshot()),
  );
}
