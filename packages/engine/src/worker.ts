import type { HogsendClient } from "./container.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { selectJourneyTasks } from "./journeys/registry.js";
import { hatchet } from "./lib/hatchet.js";
import { getPostHog } from "./lib/posthog.js";
import { getRedisIfConnected } from "./lib/redis.js";
import { checkAlertsTask } from "./workflows/check-alerts.js";
import { importContactsTask } from "./workflows/import-contacts.js";
import { sendEmailTask } from "./workflows/send-email.js";

export interface CreateWorkerOptions {
  container: HogsendClient;
  journeys: DefinedJourney[];
  /** Defaults to `container.env.ENABLED_JOURNEYS`. */
  enabledJourneys?: string;
  /** Extra client tasks registered alongside the built-in workflows. */
  extraWorkflows?: unknown[];
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorker(opts: CreateWorkerOptions): Worker {
  const { container, journeys } = opts;
  const enabled = opts.enabledJourneys ?? container.env.ENABLED_JOURNEYS;
  const journeyTasks = selectJourneyTasks(journeys, enabled);

  const baseWorkflows = [
    sendEmailTask,
    importContactsTask,
    checkAlertsTask,
    ...journeyTasks,
  ];
  const workflows = [
    ...baseWorkflows,
    ...((opts.extraWorkflows ?? []) as typeof baseWorkflows),
  ];

  // Hatchet's worker is created lazily on start so signal wiring can own its
  // lifecycle. `_worker` is captured for stop().
  let _worker: Awaited<ReturnType<typeof hatchet.worker>> | undefined;

  async function stop(): Promise<void> {
    await Promise.allSettled([
      _worker?.stop(),
      getPostHog()?.shutdown(),
      getRedisIfConnected()?.quit(),
    ]);
  }

  async function start(): Promise<void> {
    _worker = await hatchet.worker("hogsend-worker", { workflows });

    container.logger.info(
      `Hogsend worker started with ${journeyTasks.length} journey task(s)`,
    );

    await _worker.start();
  }

  return { start, stop };
}
