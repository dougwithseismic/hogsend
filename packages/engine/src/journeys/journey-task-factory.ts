import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { JourneyMeta, JourneyRunFn } from "@hogsend/core/types";

/** The durable Hatchet declaration attached to a production journey. */
export type JourneyTask = ReturnType<HatchetClient["durableTask"]>;

type JourneyTaskFactory = (meta: JourneyMeta, run: JourneyRunFn) => JourneyTask;

let taskFactory: JourneyTaskFactory | undefined;

/** Install the production Hatchet binding without coupling authoring imports to env. */
export function installJourneyTaskFactory(factory: JourneyTaskFactory): void {
  taskFactory = factory;
}

export function hasJourneyTaskFactory(): boolean {
  return taskFactory !== undefined;
}

export function createJourneyTask(
  meta: JourneyMeta,
  run: JourneyRunFn,
): JourneyTask {
  if (!taskFactory) {
    throw new Error(
      "Journey tasks require the production @hogsend/engine runtime. " +
        "Import createWorker from @hogsend/engine before selecting tasks.",
    );
  }
  return taskFactory(meta, run);
}
