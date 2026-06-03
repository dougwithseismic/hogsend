import type { DefinedBucket } from "./buckets/define-bucket.js";
import { selectBucketTasks } from "./buckets/registry.js";
import type { HogsendClient } from "./container.js";
import type { DefinedJourney } from "./journeys/define-journey.js";
import { selectJourneyTasks } from "./journeys/registry.js";
import { hatchet } from "./lib/hatchet.js";
import { getPostHog } from "./lib/posthog.js";
import { getRedisIfConnected } from "./lib/redis.js";
import {
  bucketBackfillTask,
  enqueueBucketBackfills,
} from "./workflows/bucket-backfill.js";
import { bucketReconcileTask } from "./workflows/bucket-reconcile.js";
import { checkAlertsTask } from "./workflows/check-alerts.js";
import { importContactsTask } from "./workflows/import-contacts.js";
import { sendEmailTask } from "./workflows/send-email.js";

export interface CreateWorkerOptions {
  container: HogsendClient;
  journeys: DefinedJourney[];
  /** Buckets whose fast-expiry timer tasks are registered. Defaults to none. */
  buckets?: DefinedBucket[];
  /** Defaults to `container.env.ENABLED_JOURNEYS`. */
  enabledJourneys?: string;
  /** Defaults to `container.env.ENABLED_BUCKETS`. */
  enabledBuckets?: string;
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

  const enabledBuckets = opts.enabledBuckets ?? container.env.ENABLED_BUCKETS;
  // The single place a bucket's per-user fast-expiry timer task is constructed
  // (Section 9.4): the shared `bucket:arm-expiry` durableTask, registered once iff
  // any enabled bucket opts into fastExpiry. The engine-wide time-based-leave
  // reconcile cron (bucketReconcileTask) is ALWAYS registered in baseWorkflows
  // below (Section 10), regardless of fastExpiry.
  const bucketTasks = selectBucketTasks(opts.buckets ?? [], enabledBuckets);

  const baseWorkflows = [
    sendEmailTask,
    importContactsTask,
    checkAlertsTask,
    bucketReconcileTask,
    bucketBackfillTask,
    ...journeyTasks,
    ...bucketTasks,
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

    // Boot-time backfill / criteria-change re-eval (Section 6.6 B): diff each
    // enabled bucket's criteriaHash against bucket_configs and trigger a
    // backfill/re-eval run where it differs. Kicked off BEFORE the listener
    // because `_worker.start()` below does NOT return until the worker stops —
    // anything after it is dead code at runtime. The triggers are fire-and-forget
    // (runNoWait) and execute once the listener is up; best-effort, never blocks.
    enqueueBucketBackfills({
      db: container.db,
      logger: container.logger,
    }).catch((err) => {
      container.logger.warn("Bucket backfill enqueue (boot) failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    await _worker.start();
  }

  return { start, stop };
}
