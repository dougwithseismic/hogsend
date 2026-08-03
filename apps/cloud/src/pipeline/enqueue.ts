import { env } from "../env";
import { getCloudHatchet, getProvisionStackTask } from "./hatchet";
import type { ProvisionDeps, ProvisionResult } from "./provision";
import { runProvisionPipeline } from "./provision";

/**
 * The one way provisioning is ever started.
 *
 * Two backends, chosen by configuration rather than by caller:
 *
 *  - **Hatchet** whenever `CLOUD_HATCHET_CLIENT_TOKEN` is set. The work is
 *    durable, survives a deploy, and Hatchet's per-task concurrency is what
 *    stops two runs for one stack in production.
 *  - **An in-process queue** otherwise, and ONLY under the fake substrate. A
 *    fresh clone must be able to walk `requested → running` with no Hatchet at
 *    all; a REAL substrate with no Hatchet fails closed instead, because
 *    provisioning real infrastructure from a web process would lose every
 *    in-flight stack on the next deploy.
 *
 * The in-process queue is single-flight per stack (`inflight`), which is the
 * same guarantee Hatchet gives with task concurrency — deliberately, so dev and
 * production cannot disagree about whether a double-click provisions twice.
 */

export type EnqueueMode =
  /** Pushed to Hatchet; the worker runs it. */
  | "hatchet"
  /** Scheduled on this process's queue. */
  | "inline"
  /** A run for this stack was already in flight; this call joined it. */
  | "joined";

export interface EnqueueResult {
  stackId: string;
  mode: EnqueueMode;
}

/**
 * TEST/DEV SEAM. The inline runner has no argument through which a caller can
 * inject dependencies — it is reached from a server action, three layers up —
 * so the overrides live here, module-scoped, and tests set them explicitly.
 * Empty in production, where every default is the real service.
 */
let depsOverride: Partial<ProvisionDeps> = {};

/** Install pipeline dependency overrides for the in-process runner. */
export function configureProvisioning(overrides: Partial<ProvisionDeps>): void {
  depsOverride = overrides;
}

/** Drop every override installed by {@link configureProvisioning}. */
export function resetProvisioning(): void {
  depsOverride = {};
}

/** In-flight in-process runs, keyed by stack id. The single-flight lock. */
const inflight = new Map<string, Promise<ProvisionResult>>();

/**
 * Start (or join) provisioning for `stackId`. Never throws for a pipeline
 * failure: the stack is parked in `error` by the pipeline itself, and the
 * caller — a signup action, a dashboard button — must not have its own success
 * undone by infrastructure it does not own.
 */
export async function enqueueProvision(
  stackId: string,
): Promise<EnqueueResult> {
  const hatchet = getCloudHatchet();
  if (hatchet) {
    await getProvisionStackTask(hatchet).runNoWait({ stackId });
    return { stackId, mode: "hatchet" };
  }

  if (env.CLOUD_SUBSTRATE !== "fake") {
    throw new Error(
      `Refusing to provision stack ${stackId} in-process: CLOUD_SUBSTRATE=${env.CLOUD_SUBSTRATE} requires CLOUD_HATCHET_CLIENT_TOKEN so provisioning is durable`,
    );
  }

  if (inflight.has(stackId)) return { stackId, mode: "joined" };

  const run = schedule(stackId);
  inflight.set(stackId, run);
  // Clear the lock whatever happened; a failed run must be retryable.
  void run.finally(() => {
    inflight.delete(stackId);
  });

  return { stackId, mode: "inline" };
}

/**
 * Hand control back to the event loop before running. The caller is usually
 * finishing a transaction and about to redirect; provisioning must not be on
 * that request's critical path.
 */
function schedule(stackId: string): Promise<ProvisionResult> {
  return new Promise<ProvisionResult>((resolve) => {
    setImmediate(() => {
      resolve(
        runProvisionPipeline({ stackId }, depsOverride).catch((error) => {
          // Only a pre-pipeline failure (an unknown stack, an unbuildable
          // substrate) reaches here — step failures are already recorded on the
          // row. Log and resolve: an unhandled rejection would take the process
          // down over one tenant.
          console.error(
            `[cloud] provisioning ${stackId} could not start:`,
            error,
          );
          return {
            stackId,
            status: "error" as const,
            steps: [],
            failedStep: "start" as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }),
      );
    });
  });
}

/**
 * Await the in-process run for `stackId`, if there is one. The dev/test way to
 * observe a fire-and-forget enqueue; production's answer is the stack's status,
 * polled by the dashboard.
 */
export async function waitForProvision(
  stackId: string,
): Promise<ProvisionResult | null> {
  const run = inflight.get(stackId);
  return run ? await run : null;
}
