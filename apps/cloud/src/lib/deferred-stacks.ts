import { enqueueProvision as defaultEnqueueProvision } from "../pipeline/enqueue";
import { IllegalTransitionError } from "../services/errors";
import { StackService } from "../services/stacks";

/**
 * The other half of `CLOUD_PROVISION_ON=first-publish` (PRD 15): the moment a
 * customer actually publishes, the substrate they deferred is asked for.
 *
 * The laws this module exists to hold:
 *
 *  - **The promotion is the guarded UPDATE, not a read.** `deferred →
 *    requested` is taken through `StackService.transition` with
 *    `expectedFrom: "deferred"`, so two concurrent publishes serialise on the
 *    row and exactly one takes the edge. The loser is told
 *    `IllegalTransitionError` and reports `promoted: false` — which is not an
 *    error for it, because the stack it wanted is now `requested` either way.
 *  - **Only the winner enqueues.** The enqueue rides on the transition's
 *    answer, so a stack cannot be handed to the provisioner twice by two
 *    publishes racing the same first upload. (`enqueueProvision` is
 *    single-flight per stack in its own right; this is the belt to that
 *    braces, and it is what makes the race assertable from the database.)
 *  - **A failed enqueue does not fail the publish.** Same posture as signup: a
 *    momentarily unreachable queue is a sweep's problem, and a `requested`
 *    stack is exactly what the provision sweep exists to find. Refusing the
 *    upload would lose a tarball over infrastructure the customer does not own.
 *  - **Every other status is left alone.** A `running` stack needs nothing, a
 *    `provisioning` one is already on its way, and an `error` one belongs to
 *    the sweep. The intake calls this unconditionally and this module decides.
 */

export interface PromoteDeferredStackResult {
  /** null when the environment has no stack row at all. */
  stackId: string | null;
  /** The status the stack was found in. */
  from: string | null;
  /** True only for the caller that actually took the `deferred → requested` edge. */
  promoted: boolean;
}

export interface PromoteDeferredStackDeps {
  stackService?: StackService;
  /** Injected so a test can assert the enqueue without infrastructure work. */
  enqueueProvision?: (stackId: string) => Promise<unknown>;
}

/**
 * Promote this environment's stack out of `deferred` and ask for substrate.
 * A no-op (and NOT an error) for a stack in any other status.
 */
export async function promoteDeferredStack(
  input: { environmentId: string; actor?: string },
  deps: PromoteDeferredStackDeps = {},
): Promise<PromoteDeferredStackResult> {
  const stackService = deps.stackService ?? new StackService();
  const enqueue = deps.enqueueProvision ?? defaultEnqueueProvision;

  const stack = await stackService.getByEnvironment({
    environmentId: input.environmentId,
  });
  if (!stack) return { stackId: null, from: null, promoted: false };
  if (stack.status !== "deferred") {
    return { stackId: stack.id, from: stack.status, promoted: false };
  }

  try {
    await stackService.transition({
      stackId: stack.id,
      to: "requested",
      // The guard IS the race resolution: the loser matches zero rows.
      expectedFrom: "deferred",
      actor: input.actor ?? "publish-intake",
      detail: { reason: "first publish" },
    });
  } catch (error) {
    // Somebody else promoted it between the read and the write. Their enqueue
    // is the one that counts; this caller simply proceeds with its build.
    if (error instanceof IllegalTransitionError) {
      return { stackId: stack.id, from: "deferred", promoted: false };
    }
    throw error;
  }

  try {
    await enqueue(stack.id);
  } catch (error) {
    console.error(
      `[cloud] Could not enqueue provisioning for promoted stack ${stack.id}:`,
      error,
    );
  }

  return { stackId: stack.id, from: "deferred", promoted: true };
}
