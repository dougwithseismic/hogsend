import type { JourneySourceLocation } from "@hogsend/core";
import { createSingleton } from "../lib/singleton.js";

/**
 * Process-singleton: enabled journey id → its `defineJourney` call-site
 * `{ path, line }`, installed by `buildJourneyRegistry` alongside the run-source
 * map. Read by the container so the Studio journey-graph route can hand the
 * editor a `cursor://file/<path>:<line>` deep link. Only journeys whose
 * call-site was captured are present (e.g. bucket-generated reaction journeys
 * have none).
 */
const singleton = createSingleton<Map<string, JourneySourceLocation>>(
  "Journey source locations",
);

export const setJourneySourceLocations = singleton.set;
export const getJourneySourceLocations = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetJourneySourceLocations = singleton.reset;
