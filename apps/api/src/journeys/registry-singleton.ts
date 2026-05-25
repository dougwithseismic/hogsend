import type { JourneyRegistry } from "@hogsend/core/registry";

let _registry: JourneyRegistry | undefined;

export function setJourneyRegistry(registry: JourneyRegistry): void {
  _registry = registry;
}

export function getJourneyRegistrySingleton(): JourneyRegistry {
  if (!_registry) {
    throw new Error(
      "Journey registry not initialized. Call setJourneyRegistry() at startup.",
    );
  }
  return _registry;
}
