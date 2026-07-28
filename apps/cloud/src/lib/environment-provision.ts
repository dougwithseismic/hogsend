import { enqueueProvision as defaultEnqueueProvision } from "../pipeline/enqueue";
import type {
  CreateEnvironmentInput,
  CreateEnvironmentResult,
  EnvironmentService,
} from "../services/environments";
import { environmentService as defaultEnvironmentService } from "../services/environments";

/**
 * THE environment-creation path, and the twin of `lib/org-provision.ts`.
 *
 * `EnvironmentService.create` deliberately stops at a `requested` stack: it is
 * the transactional rule-keeper (plan allowance, single production) and must
 * not reach infrastructure from inside its transaction. Enqueuing lives HERE,
 * one layer up and AFTER the commit, so the same EARS that covers signup —
 * provisioning starts with no operator action — covers a second environment
 * too, and so a queue outage can never roll back an environment that was
 * legitimately created.
 *
 * Every UI/API caller creates environments through this function; calling the
 * service directly would produce a stack nobody ever provisions.
 */

export interface ProvisionEnvironmentDeps {
  environmentService?: EnvironmentService;
  enqueueProvision?: (stackId: string) => Promise<unknown>;
}

export async function provisionEnvironment(
  input: CreateEnvironmentInput,
  deps: ProvisionEnvironmentDeps = {},
): Promise<CreateEnvironmentResult> {
  const environments = deps.environmentService ?? defaultEnvironmentService;
  const enqueue = deps.enqueueProvision ?? defaultEnqueueProvision;

  const created = await environments.create(input);

  try {
    await enqueue(created.stack.id);
  } catch (error) {
    console.error(
      `[cloud] Could not enqueue provisioning for stack ${created.stack.id}:`,
      error,
    );
  }

  return created;
}
