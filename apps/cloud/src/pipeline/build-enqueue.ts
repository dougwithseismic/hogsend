import { env } from "../env";
import {
  type BuildRow,
  buildService,
  type CreateBuildInput,
} from "../services/builds";
import type { BuildPipelineResult } from "./build";
import { runBuildOnHost } from "./build-host";
import { getCloudHatchet, getRunBuildTask } from "./hatchet";

/**
 * The one way a build is ever started — the exact shape `enqueueProvision` has,
 * deliberately, so the two pipelines cannot disagree about durability:
 *
 *  - **Hatchet** whenever `CLOUD_HATCHET_CLIENT_TOKEN` is set. A build takes
 *    minutes and outlives any web request; Hatchet is what makes it survive a
 *    deploy of the control plane.
 *  - **An in-process runner** otherwise, and ONLY under the fake substrate. A
 *    fresh clone must be able to walk a publish end to end with no Hatchet; a
 *    REAL substrate with no Hatchet fails closed instead, because building and
 *    deploying tenant code from a web process would lose every in-flight build
 *    on the next deploy.
 *
 * Single-flight is NOT enforced here. It is the partial unique index on
 * `builds` (`builds_environment_running_unique_idx`): a build that tries to
 * START while another is running for the same environment is refused by
 * Postgres and stays `queued` — an answer that stays correct with two
 * control-plane replicas, which an in-process lock could not manage.
 *
 * A publish is therefore never refused for a busy environment: it QUEUES (PRD
 * 08). Two things drain that queue — this module, which starts the next waiting
 * build as soon as an in-process run finishes, and the minute sweep, which is
 * the backstop for the Hatchet path and for a control plane that died holding
 * the baton.
 */

export type BuildEnqueueMode = "hatchet" | "inline" | "joined";

export interface BuildEnqueueResult {
  buildId: string;
  mode: BuildEnqueueMode;
}

/** In-flight in-process runs, keyed by build id. */
const inflight = new Map<string, Promise<BuildPipelineResult>>();

/**
 * Record the build AND start it. The thin wrapper the publish intake calls, so
 * "a queued build gets picked up" is one fact in one place rather than a
 * convention every caller has to remember.
 *
 * The enqueue is deliberately AFTER the insert and outside its transaction: a
 * build that was queued but not enqueued is recoverable (the sweep finds it),
 * whereas a build enqueued before its row committed is a task that races a row
 * that may never exist.
 */
export async function createAndEnqueueBuild(
  input: CreateBuildInput,
): Promise<BuildRow> {
  const row = await buildService.create(input);
  await enqueueBuild(row.id).catch((error: unknown) => {
    // Never fail the publish over the queue: the row is `queued` and the sweep
    // is the backstop. The upload succeeded; that is what the caller asked for.
    console.error(`[cloud] build ${row.id} could not be enqueued:`, error);
  });
  return row;
}

/** Start (or join) the build for `buildId`. */
export async function enqueueBuild(
  buildId: string,
): Promise<BuildEnqueueResult> {
  const hatchet = getCloudHatchet();
  if (hatchet) {
    await getRunBuildTask(hatchet).runNoWait({ buildId });
    return { buildId, mode: "hatchet" };
  }

  if (env.CLOUD_SUBSTRATE !== "fake") {
    throw new Error(
      `Refusing to build ${buildId} in-process: CLOUD_SUBSTRATE=${env.CLOUD_SUBSTRATE} requires CLOUD_HATCHET_CLIENT_TOKEN so builds are durable`,
    );
  }

  if (inflight.has(buildId)) return { buildId, mode: "joined" };

  const run = schedule(buildId);
  inflight.set(buildId, run);
  void run.finally(() => {
    inflight.delete(buildId);
  });
  return { buildId, mode: "inline" };
}

/**
 * Start the next build WAITING for the environment this one belonged to.
 *
 * The queue's drain on the in-process path. Without it a publish that arrived
 * while another build was running would sit `queued` until the minute sweep
 * noticed — and on a machine with no Hatchet (a fresh clone, the fake
 * substrate) there is no sweep at all, so it would sit there forever.
 *
 * Best-effort by construction: every failure here is one the sweep also covers.
 */
async function drainQueue(buildId: string): Promise<void> {
  const finished = await buildService.get({ buildId });
  if (!finished) return;
  const next = await buildService.nextQueued({
    environmentId: finished.environmentId,
  });
  // Not this build again: a skipped run leaves the row queued, and starting it
  // straight back would spin.
  if (!next || next.id === buildId) return;
  await enqueueBuild(next.id);
}

/** Hand control back to the event loop: a publish must not wait on a build. */
function schedule(buildId: string): Promise<BuildPipelineResult> {
  return new Promise<BuildPipelineResult>((resolve) => {
    setImmediate(() => {
      resolve(
        runBuildOnHost({ buildId })
          .then(async (result) => {
            // Only a run that actually finished frees the environment. A
            // `skipped` one did not hold it, and draining after it would loop.
            if (result.status !== "skipped") {
              await drainQueue(buildId).catch((error: unknown) => {
                console.error(
                  `[cloud] could not start the next queued build after ${buildId}:`,
                  error,
                );
              });
            }
            return result;
          })
          .catch((error: unknown) => {
            // Only a pre-pipeline failure (an unknown build) reaches here — stage
            // failures are already recorded on the row.
            console.error(`[cloud] build ${buildId} could not start:`, error);
            return {
              buildId,
              status: "failed" as const,
              steps: [],
              transitions: [],
              error: error instanceof Error ? error.message : String(error),
            };
          }),
      );
    });
  });
}
