import type { DefinedContactSource } from "./define-contact-source.js";

/**
 * In-process index of the registered contact sources (Clay, Attio, generic
 * webhook, …), keyed by `meta.id`. Mirrors {@link ListRegistry} /
 * `ConnectorRegistry`: a plain id-keyed map plus the one predicate the rest of
 * the engine needs — {@link ContactSourceRegistry.isProspectSource}, which
 * decides whether a contact's stamped `contacts.source` names a Contact Source
 * (⇒ a cold **prospect**) versus an ordinary inbound origin ("api"/"posthog").
 * The cold posture + write-back adapter travel with each entry so the cold gate
 * and the write-back step can resolve them by source id.
 */
export class ContactSourceRegistry {
  private sources: Map<string, DefinedContactSource> = new Map();

  register(source: DefinedContactSource): void {
    this.sources.set(source.meta.id, source);
  }

  get(id: string): DefinedContactSource | undefined {
    return this.sources.get(id);
  }

  getAll(): DefinedContactSource[] {
    return Array.from(this.sources.values());
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  count(): number {
    return this.sources.size;
  }

  /**
   * Does `source` (a `contacts.source` value) name a registered Contact Source?
   * A contact whose provenance is a Contact Source id is a cold **prospect**;
   * one stamped with a plain pipeline origin ("api"/"posthog"/…) or null is not.
   * Null/undefined ⇒ false (an un-sourced contact is never a prospect).
   */
  isProspectSource(source: string | null | undefined): boolean {
    return source != null && this.sources.has(source);
  }
}

// The process singleton — installed by `createHogsendClient` at container build
// so the cold gate + write-back can resolve a source without threading the
// container. Defaults to an empty registry (no sources ⇒ nothing is a prospect
// source), mirroring the lists registry-singleton.
let currentRegistry: ContactSourceRegistry | undefined;

export function setContactSourceRegistry(
  registry: ContactSourceRegistry,
): void {
  currentRegistry = registry;
}

export function getContactSourceRegistry(): ContactSourceRegistry {
  return currentRegistry ?? new ContactSourceRegistry();
}

/** Build a {@link ContactSourceRegistry} from sources and install the singleton. */
export function buildContactSourceRegistry(
  sources: DefinedContactSource[] = [],
): ContactSourceRegistry {
  const registry = new ContactSourceRegistry();
  for (const source of sources) registry.register(source);
  setContactSourceRegistry(registry);
  return registry;
}
