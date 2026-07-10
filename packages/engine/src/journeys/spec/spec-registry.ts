import type { JourneySpec } from "@hogsend/core";

/**
 * Process-local registry of loaded journey specs, keyed by journey id.
 * Populated by `journeyFromSpec` at definition time and read by the admin
 * graph route (spec journeys render their graph from the spec itself — full
 * fidelity, no source parsing — instead of the `runSource` AST walk, which
 * would only ever see the interpreter's own source).
 *
 * A plain module Map (not a boot-installed singleton): the producer runs at
 * module load, before any client exists, and re-registration of the same id
 * is an idempotent overwrite (API + worker processes each load their own).
 */
const specs = new Map<string, JourneySpec>();

export function registerJourneySpec(spec: JourneySpec): void {
  specs.set(spec.id, spec);
}

export function getJourneySpec(id: string): JourneySpec | undefined {
  return specs.get(id);
}

/** Test-only cleanup. */
export function resetJourneySpecs(): void {
  specs.clear();
}
