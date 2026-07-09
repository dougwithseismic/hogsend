import type { JourneySourceLocation } from "@hogsend/core";
import { JourneyRegistry } from "@hogsend/core/registry";
import type { DefinedJourney } from "./define-journey.js";
import { setJourneySourceLocations } from "./journey-source-locations-singleton.js";
import { setJourneySources } from "./journey-sources-singleton.js";
import { setJourneyRegistry } from "./registry-singleton.js";

/**
 * Parse the `ENABLED_JOURNEYS` filter. Returns `"*"` to enable all journeys, or
 * a `Set` of journey ids to enable. An empty/whitespace/`*` value means all.
 */
export function parseEnabledFilter(filter?: string): "*" | Set<string> {
  if (!filter || filter.trim() === "*") return "*";
  return new Set(
    filter
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Build a {@link JourneyRegistry} from an injected array of journeys, applying
 * the enabled filter, and install it as the process singleton (so durable tasks
 * can resolve it). Returns the registry.
 */
export function buildJourneyRegistry(
  journeys: DefinedJourney[],
  enabledFilter?: string,
): JourneyRegistry {
  const registry = new JourneyRegistry();
  const enabled = parseEnabledFilter(enabledFilter);

  // Captured `run` sources for the enabled journeys (skip ones whose source
  // failed to serialize). Installed as a sibling singleton so the container can
  // expose it and the Studio journey-graph route can parse lazily.
  const sources = new Map<string, string>();
  // Captured `defineJourney` call-sites (skip ones with no capturable frame).
  // Sibling singleton so the Studio route can build an "open in editor" link.
  const locations = new Map<string, JourneySourceLocation>();

  for (const journey of journeys) {
    if (enabled === "*" || enabled.has(journey.meta.id)) {
      registry.register(journey.meta);
      if (journey.runSource) {
        sources.set(journey.meta.id, journey.runSource);
      }
      if (journey.source) {
        locations.set(journey.meta.id, journey.source);
      }
    }
  }

  setJourneyRegistry(registry);
  setJourneySources(sources);
  setJourneySourceLocations(locations);
  return registry;
}

/**
 * Select the Hatchet durable tasks for the enabled journeys from an injected
 * array of journeys.
 */
export function selectJourneyTasks(
  journeys: DefinedJourney[],
  enabledFilter?: string,
) {
  const enabled = parseEnabledFilter(enabledFilter);
  return journeys
    .filter((j) => enabled === "*" || enabled.has(j.meta.id))
    .map((j) => j.task);
}
