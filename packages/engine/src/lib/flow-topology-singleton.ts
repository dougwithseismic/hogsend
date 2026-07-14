import type { FlowTopology } from "./flow-topology.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * Process singleton for the flow-map topology — set by `createHogsendClient`
 * (both API and worker call it), read by module-level sites with no client
 * reference. Today that's tests; P4's live-particle hook in `ingestEvent()`
 * (which is container-less by design) is the reason it exists at all. Mirrors
 * the `crm-registry-singleton` pattern.
 *
 * Optional: a process that never built a container (a bare script) leaves it
 * unset and callers no-op rather than throw.
 */
const singleton = createOptionalSingleton<FlowTopology>();

export const setFlowTopology = singleton.set;
export const getFlowTopology = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetFlowTopology = singleton.reset;
