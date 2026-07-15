import type { JourneyMeta, JourneyRunFn } from "@hogsend/core/types";
import { hatchet } from "../lib/hatchet.js";
import {
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_SCHEDULE_TIMEOUT,
} from "./constants.js";
import {
  type EventPayloadInput,
  executeJourneyRun,
} from "./execute-journey-run.js";
import { installJourneyTaskFactory } from "./journey-task-factory.js";

/**
 * Bind pure journey definitions to Hatchet only in production engine entry
 * points. `@hogsend/engine/journeys` deliberately does not import this module,
 * which keeps authoring modules importable without runtime credentials.
 */
installJourneyTaskFactory((meta: JourneyMeta, run: JourneyRunFn) =>
  hatchet.durableTask({
    name: `journey-${meta.id}`,
    onEvents: [meta.trigger.event],
    executionTimeout: JOURNEY_EXECUTION_TIMEOUT,
    // retries STAYS 0 — deliberately. A retry replays `run()` from the top, and
    // provider delivery cannot yet be made atomic with the durable status flip.
    retries: 0,
    // Give durable-wait resumes enough queue headroom during deploy saturation.
    scheduleTimeout: JOURNEY_SCHEDULE_TIMEOUT,
    fn: async (input: EventPayloadInput, hatchetCtx) =>
      executeJourneyRun({ meta, run, input, hatchetCtx }),
  }),
);
