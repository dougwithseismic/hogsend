import type { JourneyRegistry } from "@hogsend/core/registry";
import { createSingleton } from "../lib/singleton.js";

const singleton = createSingleton<JourneyRegistry>("Journey registry");

export const setJourneyRegistry = singleton.set;
export const getJourneyRegistrySingleton = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetJourneyRegistry = singleton.reset;
