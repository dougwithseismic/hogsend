import type { EnrichmentProvider } from "@hogsend/core";
import type { EnrichmentProviderRegistry } from "./enrichment-provider-registry.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * The process-wide enrichment-provider state, set once by `createHogsendClient`
 * at startup: the full registry plus the ONE resolved active provider (may be
 * undefined — a deploy with no enrichment configured is a valid deploy).
 *
 * A singleton (not just a container field) because `refineContact()` (PRD 03)
 * is a STANDALONE import called from journey `run` functions and crons that
 * hold no container reference — the same reason `sendEmail`/`sendSms` read
 * their services off singletons. Optional variant: `get` never throws;
 * `refineContact` fails per-call with an actionable message when unset.
 */
interface EnrichmentProviderState {
  registry: EnrichmentProviderRegistry;
  /** The resolved ACTIVE provider. Undefined when none is configured. */
  active?: EnrichmentProvider;
}

const singleton = createOptionalSingleton<EnrichmentProviderState>();

export function setEnrichmentProviders(
  registry: EnrichmentProviderRegistry,
  active?: EnrichmentProvider,
): void {
  singleton.set({ registry, active });
}

export function getEnrichmentProviderRegistry():
  | EnrichmentProviderRegistry
  | undefined {
  return singleton.get()?.registry;
}

/** The single resolved active enrichment provider (undefined = not configured). */
export function getEnrichmentProvider(): EnrichmentProvider | undefined {
  return singleton.get()?.active;
}

/** Reset the installed state — only for test cleanup. */
export function resetEnrichmentProviders(): void {
  singleton.reset();
}
