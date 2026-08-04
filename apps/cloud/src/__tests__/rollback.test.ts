import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { builds, environments, organizations, stacks } from "../db/schema";
import { env } from "../env";
import { rollbackToBuild } from "../pipeline/rollback";
import { NotFoundError } from "../services/errors";
import { FakeSubstrate, type StackRefs, SubstrateError } from "../substrate";

/**
 * Rollback, against a REAL database, because the guards under test are the
 * database's: the status transition that keeps a rollback and a publish from
 * running over each other, and the environment scope that keeps one tenant's
 * build id from being deployable onto another tenant's stack.
 *
 * The substrate is the fake — what matters here is WHICH image was asked for
 * and in what order, not that a container really started.
 */

const ORG = "rollback-test-org";
const OTHER_ORG = "rollback-test-other-org";
const ACTOR = "rollback-test-user";

async function cleanup(): Promise<void> {
  await db
    .delete(organizations)
    .where(inArray(organizations.id, [ORG, OTHER_ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db.insert(organizations).values([
    { id: ORG, name: "Rollback Test Org", region: "us" },
    { id: OTHER_ORG, name: "Rollback Other Org", region: "us" },
  ]);
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

/**
 * An environment with a running stack and one succeeded build on it.
 *
 * The stack is provisioned through the SUBSTRATE, not just inserted, so the
 * refs on the row are handles the fake will actually recognise — a hand-written
 * refs blob would make every deploy a not-found and the tests vacuous.
 */
async function seed(
  substrate: FakeSubstrate,
  options: {
    organizationId?: string;
    stackStatus?: "running" | "suspended";
    buildStatus?: "succeeded" | "failed";
  } = {},
) {
  const organizationId = options.organizationId ?? ORG;
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId,
      name: `env-${randomUUID().slice(0, 8)}`,
      kind: "production",
    })
    .returning();
  if (!environment) throw new Error("fixture environment not created");

  const stackId = randomUUID();
  const refs: StackRefs = await substrate.provisionRunningStack({
    stackId,
    organizationId,
    environmentName: environment.name,
    region: "us",
    topology: "shared",
    env: {},
  });
  const [stack] = await db
    .insert(stacks)
    .values({
      id: stackId,
      organizationId,
      environmentId: environment.id,
      status: options.stackStatus ?? "running",
      region: "us",
      substrateRefs: { ...refs },
      imageDigest: "sha256:current",
    })
    .returning();
  if (!stack) throw new Error("fixture stack not created");

  const [build] = await db
    .insert(builds)
    .values({
      environmentId: environment.id,
      stackId: stack.id,
      status: options.buildStatus ?? "succeeded",
      artifactPath: `${environment.id}/x.tar.gz`,
      imageDigest: "sha256:older",
      engineVersion: "0.50.0",
    })
    .returning();
  if (!build) throw new Error("fixture build not created");

  return { environmentId: environment.id, stackId: stack.id, build };
}

describe("rollbackToBuild", () => {
  it("redeploys the build's image, worker before api", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate);

    const result = await rollbackToBuild(
      {
        environmentId: fixture.environmentId,
        buildId: fixture.build.id,
        actor: ACTOR,
      },
      { substrate },
    );

    const deploys = substrate.calls.filter(
      (call) => call.method === "deployImage",
    );
    expect(deploys).toHaveLength(2);
    // Worker first: it takes no inbound traffic, so a bad image is discovered
    // there rather than in front of customers.
    expect((deploys[0]?.args[1] as { service: string }).service).toBe("worker");
    expect((deploys[1]?.args[1] as { service: string }).service).toBe("api");
    // The image is reconstructed from the build id — nothing extra is stored.
    expect(result.reference).toContain(fixture.build.id);
  });

  // Otherwise the dashboard keeps describing an image the stack stopped running.
  it("moves the stack's recorded digest onto the rolled-back build", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate);

    await rollbackToBuild(
      {
        environmentId: fixture.environmentId,
        buildId: fixture.build.id,
        actor: ACTOR,
      },
      { substrate },
    );

    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(stack?.imageDigest).toBe("sha256:older");
    expect(stack?.engineVersion).toBe("0.50.0");
    // And it is handed back, not left in a working status.
    expect(stack?.status).toBe("running");
  });

  // A failed build may never have reached the registry. Deploying it would
  // take the stack down on a pull error.
  it("refuses a build that did not succeed", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, { buildStatus: "failed" });

    await expect(
      rollbackToBuild(
        {
          environmentId: fixture.environmentId,
          buildId: fixture.build.id,
          actor: ACTOR,
        },
        { substrate },
      ),
    ).rejects.toThrow(/not succeeded/);
  });

  // THE tenancy guard: a build id is not deployable just because it exists.
  it("refuses a build belonging to another environment", async () => {
    const substrate = new FakeSubstrate();
    const mine = await seed(substrate);
    const theirs = await seed(substrate, { organizationId: OTHER_ORG });

    await expect(
      rollbackToBuild(
        {
          environmentId: mine.environmentId,
          buildId: theirs.build.id,
          actor: ACTOR,
        },
        { substrate },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a stack that is not running", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate, { stackStatus: "suspended" });

    await expect(
      rollbackToBuild(
        {
          environmentId: fixture.environmentId,
          buildId: fixture.build.id,
          actor: ACTOR,
        },
        { substrate },
      ),
    ).rejects.toThrow(/not running/);
  });

  // A rollback that failed AND left the stack in `publishing` would block the
  // next publish too — the outage would outlive the mistake.
  it("hands the stack back when the deploy fails", async () => {
    const substrate = new FakeSubstrate();
    const fixture = await seed(substrate);
    substrate.failNext(
      "deployImage",
      new SubstrateError("scripted rollout failure"),
    );

    await expect(
      rollbackToBuild(
        {
          environmentId: fixture.environmentId,
          buildId: fixture.build.id,
          actor: ACTOR,
        },
        { substrate },
      ),
    ).rejects.toThrow(/scripted rollout failure/);

    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(stack?.status).toBe("running");
    // And the digest is untouched — nothing was rolled back.
    expect(stack?.imageDigest).toBe("sha256:current");
  });
});
