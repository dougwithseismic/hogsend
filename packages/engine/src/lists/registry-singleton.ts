import { ListRegistry } from "./registry.js";

/**
 * Process-singleton for the {@link ListRegistry}, installed by
 * `createHogsendClient` / `buildListRegistry` at startup.
 *
 * Unlike the journey/bucket singletons (which `throw` if read before set), this
 * one is EMPTY-DEFAULT and NEVER throws: `tracked.ts`'s `checkSuppression` runs
 * in BOTH the API and the worker, and a send issued before
 * `createHogsendClient` installs the registry — or a test that constructs no
 * client at all — must still resolve. An empty registry yields legacy behaviour
 * (every unknown id → opt-in default → blocked only on explicit `false`), so the
 * pre-init / no-client path degrades safely instead of crashing (open risk #12).
 */
// Lazily constructed: `registry.ts` ↔ `registry-singleton.ts` form an ESM
// import cycle (registry.ts imports `setListRegistry`; this file imports the
// `ListRegistry` class). A top-level `new ListRegistry()` here would touch the
// class while it is still in its temporal dead zone if `registry.ts` is the
// module that loads first. Deferring construction to first read (after both
// modules finish evaluating) sidesteps the cycle.
let registry: ListRegistry | undefined;

/** Read the installed registry, or an empty (legacy-behaviour) default. */
export function getListRegistry(): ListRegistry {
  if (registry === undefined) {
    registry = new ListRegistry();
  }
  return registry;
}

/** Install the process registry (called by `buildListRegistry`). */
export function setListRegistry(next: ListRegistry): void {
  registry = next;
}

/** Reset to an empty registry — for test cleanup. */
export function resetListRegistry(): void {
  registry = new ListRegistry();
}
