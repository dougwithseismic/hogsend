import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import { builds, environments, organizations, stacks } from "../db/schema";
import { env } from "../env";
import { sweepBuilds } from "../pipeline/build-sweep";
import { BuildService, type BuildStatus } from "../services/builds";
import { StackService } from "../services/stacks";

/**
 * The build sweep, against the real database.
 *
 * Both of its jobs are recovery behaviour, so both are asserted from the rows
 * rather than from a return value alone: an orphaned `queued` build is handed
 * to the runner, and an interrupted build is FAILED — which is the part that
 * matters, because until it is, the single-flight index makes that environment
 * unable to publish ever again.
 */

const ORG = "build-sweep-test-org";
const service = new BuildService(db);
const stackService = new StackService(db);

let seq = 0;

async function seedEnvironment(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `sweep-env-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

/** A build parked in `status`, with `updated_at` set to `updatedAt`. */
async function seedBuild(
  status: BuildStatus,
  updatedAt: Date,
): Promise<string> {
  const environmentId = await seedEnvironment();
  const [row] = await db
    .insert(builds)
    .values({
      environmentId,
      status,
      artifactPath: `${environmentId}/seed.tar.gz`,
      manifest: { engineVersion: "0.57.0" },
      updatedAt,
    })
    .returning();
  if (!row) throw new Error("failed to seed build");
  return row.id;
}

/** A stack parked in `status` for `environmentId`, as the pipeline leaves it. */
async function seedStack(
  environmentId: string,
  status: "running" | "publishing",
): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(stacks)
    .values({
      organizationId: ORG,
      environmentId,
      region: "us",
      status,
      dbName: `sweep_db_${seq}`,
    })
    .returning();
  if (!row) throw new Error("failed to seed stack");
  return row.id;
}

async function statusOf(buildId: string): Promise<string> {
  const [row] = await db
    .select({ status: builds.status, error: builds.error })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  return row?.status ?? "missing";
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Build Sweep Test", region: "us" })
    .onConflictDoNothing();
});

afterAll(async () => {
  const envIds = (
    await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.organizationId, ORG))
  ).map((row) => row.id);
  if (envIds.length > 0) {
    await db.delete(builds).where(inArray(builds.environmentId, envIds));
    await db.delete(stacks).where(inArray(stacks.environmentId, envIds));
    await db.delete(environments).where(inArray(environments.id, envIds));
  }
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await sqlClient.end({ timeout: 5 });
});

describe("sweepBuilds", () => {
  it("runs an orphaned queued build, however long it has been waiting", async () => {
    // Deliberately older than the stale cutoff: a QUEUED build is not stale, it
    // is unclaimed, and reaping it would destroy the publish it represents.
    const buildId = await seedBuild(
      "queued",
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const started: string[] = [];

    const result = await sweepBuilds({
      db,
      buildService: service,
      run: async (id) => {
        started.push(id);
      },
      limit: 10,
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(started).toContain(buildId);
    expect(result.started).toContain(buildId);
    // A queued build is never reaped, however old — nothing has claimed it.
    expect(result.reaped).not.toContain(buildId);
  });

  it("reaps a build the builder was interrupted in, freeing the environment", async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const buildId = await seedBuild("building", stale);

    const result = await sweepBuilds({
      db,
      buildService: service,
      run: async () => {},
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(result.reaped).toContain(buildId);
    expect(await statusOf(buildId)).toBe("failed");

    const [row] = await db
      .select({ error: builds.error, environmentId: builds.environmentId })
      .from(builds)
      .where(eq(builds.id, buildId));
    expect(row?.error).toMatch(/interrupted/i);
    // The single-flight slot is free again: a new publish is accepted.
    const next = await service.create({
      environmentId: row?.environmentId ?? "",
      artifactPath: `${row?.environmentId}/next.tar.gz`,
      manifest: { engineVersion: "0.57.0" },
    });
    expect(next.status).toBe("queued");
  });

  it("parks the STACK of a build it reaps mid-deploy", async () => {
    // The wedge this exists for: `runBuildPipeline` moves the stack
    // `running → publishing` and only it can move the stack back out. A worker
    // killed in that window leaves a stack no publish, suspend or destroy can
    // ever touch again.
    const environmentId = await seedEnvironment();
    const stackId = await seedStack(environmentId, "publishing");
    const [build] = await db
      .insert(builds)
      .values({
        environmentId,
        stackId,
        status: "deploying",
        artifactPath: `${environmentId}/seed.tar.gz`,
        manifest: { engineVersion: "0.57.0" },
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })
      .returning();
    if (!build) throw new Error("failed to seed build");

    const result = await sweepBuilds({
      db,
      buildService: service,
      stackService,
      run: async () => {},
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(result.reaped).toContain(build.id);
    expect(result.parkedStacks).toContain(stackId);

    const [stack] = await db
      .select({ status: stacks.status, lastError: stacks.lastError })
      .from(stacks)
      .where(eq(stacks.id, stackId));
    // `error` is the one status with a retry edge out (`error → provisioning`)
    // — the wedge is now recoverable without hand-written SQL.
    expect(stack?.status).toBe("error");
    expect(stack?.lastError).toMatch(/interrupted while deploying/i);
  });

  it("leaves the stack alone when the reaped build never reached deploy", async () => {
    const environmentId = await seedEnvironment();
    const stackId = await seedStack(environmentId, "running");
    const [build] = await db
      .insert(builds)
      .values({
        environmentId,
        stackId,
        status: "building",
        artifactPath: `${environmentId}/seed.tar.gz`,
        manifest: { engineVersion: "0.57.0" },
        updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })
      .returning();
    if (!build) throw new Error("failed to seed build");

    const result = await sweepBuilds({
      db,
      buildService: service,
      stackService,
      run: async () => {},
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(result.reaped).toContain(build.id);
    expect(result.parkedStacks).not.toContain(stackId);
    const [stack] = await db
      .select({ status: stacks.status })
      .from(stacks)
      .where(eq(stacks.id, stackId));
    // A build that never claimed the stack must not fail one that is healthy.
    expect(stack?.status).toBe("running");
  });

  it("leaves a build that is merely slow alone", async () => {
    const recent = new Date(Date.now() - 60_000);
    const buildId = await seedBuild("pushing", recent);

    const result = await sweepBuilds({
      db,
      buildService: service,
      run: async () => {},
      staleAfterMs: 60 * 60 * 1000,
    });

    expect(result.reaped).not.toContain(buildId);
    expect(await statusOf(buildId)).toBe("pushing");
  });
});
