import { createSingleton } from "../lib/singleton.js";

/**
 * Process-singleton holding the map of enabled journey ids → their captured
 * `run` source (`meta.id → runSource`), installed by `buildJourneyRegistry` and
 * read by the container so the Studio journey-graph route can parse a journey's
 * source lazily. Only journeys whose `runSource` was captured are present.
 */
const singleton = createSingleton<Map<string, string>>("Journey sources");

export const setJourneySources = singleton.set;
export const getJourneySources = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetJourneySources = singleton.reset;
