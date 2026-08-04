import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { builds, environments, stacks } from "../db/schema";
import { qualifyImage } from "../images/index";
import { tenantImageTag } from "../images/tags";
import { readStackRefs } from "../lib/stack-refs";
import { writeAudit } from "../services/audit";
import { NotFoundError } from "../services/errors";
import { StackService } from "../services/stacks";
import { getSubstrate, type SubstrateProvider } from "../substrate";
import { MIGRATE_PRE_DEPLOY_COMMAND } from "./build";

/**
 * Put a previous build back on the stack.
 *
 * What this DOES: re-deploy the image a past publish produced. Image references
 * are deterministic (`tenantImageTag`), so any succeeded build can be
 * reconstructed from its row without storing anything extra, and the registry
 * still holds it.
 *
 * What this does NOT do, and the UI must say so plainly: undo database
 * migrations. Migrations are forward-only. If the build being rolled away added
 * a column, that column is still there afterwards — which is usually harmless,
 * and is exactly why "rollback" is a dangerous word to leave unqualified. A
 * customer whose new code was merely wrong gets what they want here; a customer
 * whose new code DROPPED something does not get it back.
 *
 * It deliberately reuses the build pipeline's deploy shape — worker first, api
 * second, migrations attached to the worker — so a rollback and a publish put a
 * stack through exactly the same motion. A second, subtly different deploy path
 * is how the two drift until only one of them works.
 */

/** The actor recorded on every row a rollback writes. */
export const ROLLBACK_ACTOR = "rollback";

/** Worker first: it takes no inbound traffic, so a bad image is found there. */
const DEPLOY_ORDER = ["worker", "api"] as const;

export interface RollbackDeps {
  db: CloudDb;
  substrate: SubstrateProvider;
  stackService: StackService;
}

export interface RollbackResult {
  buildId: string;
  stackId: string;
  reference: string;
}

function defaultDeps(): RollbackDeps {
  return {
    db: defaultDb,
    substrate: getSubstrate(),
    stackService: new StackService(),
  };
}

/**
 * Roll `environmentId` back onto `buildId`.
 *
 * Throws rather than parking the stack: unlike provisioning, this is a call a
 * human just made and is waiting on, so the failure belongs in front of them.
 * The `publishing` transition is reversed on the way out so a failed rollback
 * never strands a stack in a working status.
 */
export async function rollbackToBuild(
  input: { environmentId: string; buildId: string; actor: string },
  overrides: Partial<RollbackDeps> = {},
): Promise<RollbackResult> {
  const deps: RollbackDeps = { ...defaultDeps(), ...overrides };

  // Scoped by environment as well as id: a build id from another tenant must
  // not be deployable here just because it exists.
  const [build] = await deps.db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.id, input.buildId),
        eq(builds.environmentId, input.environmentId),
      ),
    )
    .limit(1);
  if (!build) throw new NotFoundError("Build", input.buildId);

  // Only a build that actually deployed. A failed one may never have reached
  // the registry, and rolling onto a missing image would take the stack down.
  if (build.status !== "succeeded") {
    throw new Error(
      `build ${input.buildId} is ${build.status}, not succeeded — only a build that deployed can be rolled back to`,
    );
  }

  const [stack] = await deps.db
    .select()
    .from(stacks)
    .where(eq(stacks.environmentId, input.environmentId))
    .limit(1);
  if (!stack) throw new NotFoundError("Stack", input.environmentId);
  if (stack.status !== "running") {
    throw new Error(
      `stack ${stack.id} is ${stack.status}, not running — a rollback deploys onto a running stack only`,
    );
  }

  const refs = readStackRefs(stack);
  if (!refs) {
    throw new Error(`stack ${stack.id} carries no substrate handle`);
  }

  const reference = qualifyImage(
    tenantImageTag({
      environmentId: input.environmentId,
      buildId: build.id,
    }),
  );

  // Same guarded status the build pipeline takes, so a rollback and a publish
  // cannot run over each other: whichever gets `publishing` first wins, and the
  // other's `expectedFrom: "running"` refuses.
  await deps.stackService.transition({
    stackId: stack.id,
    to: "publishing",
    expectedFrom: "running",
    actor: input.actor,
    detail: { verb: "rollback", buildId: build.id },
  });

  try {
    for (const [index, service] of DEPLOY_ORDER.entries()) {
      await deps.substrate.deployImage(refs, {
        imageUrl: reference,
        service,
        ...(index === 0
          ? { preDeployCommand: MIGRATE_PRE_DEPLOY_COMMAND }
          : {}),
      });
    }
  } catch (error) {
    // Hand the stack back before rethrowing. A rollback that failed AND left
    // the stack in `publishing` would block the next publish too.
    await deps.stackService
      .transition({
        stackId: stack.id,
        to: "running",
        expectedFrom: "publishing",
        actor: input.actor,
        detail: { verb: "rollback", buildId: build.id, failed: true },
      })
      .catch(() => {});
    throw error;
  }

  await deps.db
    .update(stacks)
    .set({
      // The stack now serves the ROLLED-BACK build's image, so its recorded
      // digest and engine version have to follow it. Leaving them would make
      // the dashboard describe an image the stack stopped running.
      ...(build.imageDigest ? { imageDigest: build.imageDigest } : {}),
      ...(build.engineVersion ? { engineVersion: build.engineVersion } : {}),
      updatedAt: new Date(),
    })
    .where(eq(stacks.id, stack.id));

  await deps.stackService.transition({
    stackId: stack.id,
    to: "running",
    expectedFrom: "publishing",
    actor: input.actor,
    detail: { verb: "rollback", buildId: build.id },
  });

  const [environment] = await deps.db
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, input.environmentId))
    .limit(1);
  if (environment) {
    await writeAudit(deps.db, {
      actor: input.actor,
      organizationId: environment.organizationId,
      action: "stack.rolled-back",
      subject: stack.id,
      detail: {
        buildId: build.id,
        reference,
        environmentId: input.environmentId,
      },
    }).catch(() => {});
  }

  return { buildId: build.id, stackId: stack.id, reference };
}
