import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sqlClient } from "../db";
import { runCloudMigrations } from "../db/migrator";
import {
  builds,
  cloudAuditLog,
  environments,
  organizations,
} from "../db/schema";
import { env } from "../env";
import {
  ACTIVE_BUILD_STATUSES,
  BUILD_STATUSES,
  BuildService,
  type BuildStatus,
  MAX_LOG_TAIL_CHARS,
  MAX_QUEUED_BUILDS_PER_ENVIRONMENT,
  TERMINAL_BUILD_STATUSES,
} from "../services/builds";
import {
  BuildInFlightError,
  BuildQueueFullError,
  IllegalBuildTransitionError,
  NotFoundError,
} from "../services/errors";

/**
 * Against a REAL database, because the two laws under test are Postgres':
 * the guarded UPDATE that enforces the transition table, and the PARTIAL UNIQUE
 * INDEX that enforces single-flight. A mocked driver would certify neither.
 */
const ORG = "builds-test-org";

const service = new BuildService(db);

/**
 * The transition table, written out BY HAND rather than imported from the
 * service — the same discipline `stacks.test.ts` uses. A matrix driven by
 * `LEGAL_BUILD_EDGES` would certify whatever the implementation happens to say;
 * two independent copies of the law must agree.
 */
const EXPECTED_LEGAL: ReadonlyArray<readonly [BuildStatus, BuildStatus]> = [
  ["queued", "building"],
  ["queued", "failed"],
  ["building", "preflight"],
  ["building", "failed"],
  ["preflight", "pushing"],
  ["preflight", "failed"],
  ["pushing", "deploying"],
  ["pushing", "failed"],
  ["deploying", "succeeded"],
  ["deploying", "failed"],
];

function isLegal(from: BuildStatus, to: BuildStatus): boolean {
  return EXPECTED_LEGAL.some(([f, t]) => f === from && t === to);
}

let seq = 0;

/** A fresh environment, so each case gets its own single-flight slot. */
async function seedEnvironment(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `build-env-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

/** A build parked in `status`, bypassing the service. */
async function seedBuild(
  status: BuildStatus,
  environmentId?: string,
): Promise<{ buildId: string; environmentId: string }> {
  const envId = environmentId ?? (await seedEnvironment());
  const [row] = await db
    .insert(builds)
    .values({
      environmentId: envId,
      status,
      artifactPath: `${envId}/seed.tar.gz`,
      manifest: { engineVersion: "0.56.0" },
    })
    .returning();
  if (!row) throw new Error("failed to seed build");
  return { buildId: row.id, environmentId: envId };
}

async function readBuild(buildId: string) {
  const [row] = await db.select().from(builds).where(eq(builds.id, buildId));
  if (!row) throw new Error(`build ${buildId} vanished`);
  return row;
}

async function auditFor(subject: string) {
  return db
    .select()
    .from(cloudAuditLog)
    .where(eq(cloudAuditLog.subject, subject))
    .orderBy(cloudAuditLog.createdAt);
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Builds Test Org", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("the build status vocabulary", () => {
  it("splits into exactly the active and terminal sets the index assumes", () => {
    expect([...TERMINAL_BUILD_STATUSES]).toEqual(["succeeded", "failed"]);
    expect(ACTIVE_BUILD_STATUSES).toEqual([
      "queued",
      "building",
      "preflight",
      "pushing",
      "deploying",
    ]);
  });
});

describe("BuildService.transition — the full 7x7 matrix", () => {
  for (const from of BUILD_STATUSES) {
    for (const to of BUILD_STATUSES) {
      const legal = isLegal(from, to);
      it(`${legal ? "allows" : "refuses"} ${from} -> ${to}`, async () => {
        const { buildId } = await seedBuild(from);

        if (legal) {
          const row = await service.transition({ buildId, to });
          expect(row.status).toBe(to);
          expect((await readBuild(buildId)).status).toBe(to);
          return;
        }

        await expect(
          service.transition({ buildId, to }),
        ).rejects.toBeInstanceOf(IllegalBuildTransitionError);
        // An illegal edge leaves the row EXACTLY as it was.
        expect((await readBuild(buildId)).status).toBe(from);
      });
    }
  }
});

describe("BuildService.transition", () => {
  it("stamps started_at when work leaves the queue and finished_at at the end", async () => {
    const { buildId } = await seedBuild("queued");
    expect((await readBuild(buildId)).startedAt).toBeNull();

    await service.transition({ buildId, to: "building" });
    const started = await readBuild(buildId);
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(started.finishedAt).toBeNull();

    await service.transition({ buildId, to: "preflight" });
    await service.transition({ buildId, to: "pushing" });
    await service.transition({
      buildId,
      to: "deploying",
      imageDigest: "sha256:abc123",
    });
    await service.transition({ buildId, to: "succeeded" });

    const done = await readBuild(buildId);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.imageDigest).toBe("sha256:abc123");
    expect(done.error).toBeNull();
  });

  it("does not stamp started_at when a queued build fails outright", async () => {
    const { buildId } = await seedBuild("queued");
    await service.transition({ buildId, to: "failed", error: "no worker" });

    const row = await readBuild(buildId);
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.error).toBe("no worker");
  });

  it("records the reason only on the failure it belongs to", async () => {
    const { buildId } = await seedBuild("building");
    // A reason handed to a non-failing edge is not kept on the row.
    await service.transition({ buildId, to: "preflight", error: "ignored" });
    expect((await readBuild(buildId)).error).toBeNull();

    await service.transition({
      buildId,
      to: "failed",
      error: new Error("preflight refused the image"),
    });
    expect((await readBuild(buildId)).error).toBe(
      "preflight refused the image",
    );
  });

  it("audits every legal transition with from/to, and nothing on a refusal", async () => {
    const { buildId, environmentId } = await seedBuild("queued");
    await service.transition({
      buildId,
      to: "building",
      actor: "cloud-worker",
      detail: { attempt: 1 },
    });

    const rows = await auditFor(buildId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("build.transition");
    expect(rows[0]?.actor).toBe("cloud-worker");
    expect(rows[0]?.organizationId).toBe(ORG);
    expect(rows[0]?.detail).toMatchObject({
      from: "queued",
      to: "building",
      environmentId,
      attempt: 1,
    });

    await expect(
      service.transition({ buildId, to: "succeeded" }),
    ).rejects.toBeInstanceOf(IllegalBuildTransitionError);
    expect(await auditFor(buildId)).toHaveLength(1);
  });

  it("refuses an expectedFrom the table forbids without touching the row", async () => {
    const { buildId } = await seedBuild("queued");
    await expect(
      service.transition({ buildId, to: "building", expectedFrom: "pushing" }),
    ).rejects.toBeInstanceOf(IllegalBuildTransitionError);
    expect((await readBuild(buildId)).status).toBe("queued");
  });

  it("refuses a legal edge whose expectedFrom is not where the build is", async () => {
    const { buildId } = await seedBuild("building");
    await expect(
      service.transition({ buildId, to: "failed", expectedFrom: "queued" }),
    ).rejects.toBeInstanceOf(IllegalBuildTransitionError);
    expect((await readBuild(buildId)).status).toBe("building");
  });

  it("reports an unknown build as not found", async () => {
    await expect(
      service.transition({
        buildId: "00000000-0000-4000-8000-000000000000",
        to: "building",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("BuildService.create — the per-environment publish queue", () => {
  it("creates a queued build and audits it", async () => {
    const environmentId = await seedEnvironment();
    const row = await service.create({
      environmentId,
      artifactPath: `${environmentId}/one.tar.gz`,
      manifest: { engineVersion: "0.56.0", appName: "acme" },
      engineVersion: "0.56.0",
      actor: "publish_token:abc",
    });

    expect(row.status).toBe("queued");
    expect(row.engineVersion).toBe("0.56.0");
    expect(row.manifest).toMatchObject({ appName: "acme" });
    expect(row.startedAt).toBeNull();

    const audit = await auditFor(row.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("build.created");
    expect(audit[0]?.actor).toBe("publish_token:abc");
  });

  it("queues a publish behind an unfinished build, in EVERY active status", async () => {
    for (const status of ACTIVE_BUILD_STATUSES) {
      const environmentId = await seedEnvironment();
      await seedBuild(status, environmentId);

      const queued = await service.create({
        environmentId,
        artifactPath: `${environmentId}/second.tar.gz`,
        manifest: { engineVersion: "0.56.0" },
      });
      // Accepted, and WAITING — the publish is never lost to a busy
      // environment (PRD 08: "a second publish … SHALL queue, never race").
      expect(queued.status).toBe("queued");
      expect(queued.startedAt).toBeNull();

      const rows = await db
        .select()
        .from(builds)
        .where(eq(builds.environmentId, environmentId));
      expect(rows).toHaveLength(2);
    }
  });

  it("refuses past the queue depth, storing nothing", async () => {
    const environmentId = await seedEnvironment();
    await seedBuild("building", environmentId);

    for (let n = 0; n < MAX_QUEUED_BUILDS_PER_ENVIRONMENT; n += 1) {
      const row = await service.create({
        environmentId,
        artifactPath: `${environmentId}/wait-${n}.tar.gz`,
        manifest: { engineVersion: "0.56.0" },
      });
      expect(row.status).toBe("queued");
    }

    await expect(
      service.create({
        environmentId,
        artifactPath: `${environmentId}/one-too-many.tar.gz`,
        manifest: { engineVersion: "0.56.0" },
      }),
    ).rejects.toBeInstanceOf(BuildQueueFullError);

    const rows = await db
      .select()
      .from(builds)
      .where(eq(builds.environmentId, environmentId));
    expect(rows).toHaveLength(1 + MAX_QUEUED_BUILDS_PER_ENVIRONMENT);
  });

  it("allows a new build once the previous one is terminal", async () => {
    for (const status of TERMINAL_BUILD_STATUSES) {
      const environmentId = await seedEnvironment();
      await seedBuild(status, environmentId);

      const row = await service.create({
        environmentId,
        artifactPath: `${environmentId}/next.tar.gz`,
        manifest: { engineVersion: "0.57.0" },
      });
      expect(row.status).toBe("queued");
    }
  });

  it("holds the queue depth under concurrent creates", async () => {
    const environmentId = await seedEnvironment();
    // One more attempt than the queue can hold, all at once: the depth check is
    // a read followed by a write, so without the advisory lock two of these
    // would read the same count and both insert.
    const attempts = await Promise.allSettled(
      Array.from({ length: MAX_QUEUED_BUILDS_PER_ENVIRONMENT + 2 }, (_, n) =>
        service.create({
          environmentId,
          artifactPath: `${environmentId}/race-${n}.tar.gz`,
          manifest: { engineVersion: "0.56.0" },
        }),
      ),
    );

    const created = attempts.filter((a) => a.status === "fulfilled");
    expect(created).toHaveLength(MAX_QUEUED_BUILDS_PER_ENVIRONMENT);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason).toBeInstanceOf(BuildQueueFullError);
      }
    }

    const rows = await db
      .select()
      .from(builds)
      .where(eq(builds.environmentId, environmentId));
    expect(rows).toHaveLength(MAX_QUEUED_BUILDS_PER_ENVIRONMENT);
  });

  it("lets exactly one queued build START, and leaves the rest queued", async () => {
    const environmentId = await seedEnvironment();
    const queued = await Promise.all(
      [1, 2, 3].map((n) =>
        service.create({
          environmentId,
          artifactPath: `${environmentId}/claim-${n}.tar.gz`,
          manifest: { engineVersion: "0.56.0" },
        }),
      ),
    );

    // Single-flight lives at the CLAIM now, not at the insert: three workers
    // racing `queued → building` for one environment, one winner.
    const claims = await Promise.allSettled(
      queued.map((row) =>
        service.transition({
          buildId: row.id,
          to: "building",
          expectedFrom: "queued",
          actor: "builder",
        }),
      ),
    );
    expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    for (const claim of claims) {
      if (claim.status === "rejected") {
        expect(claim.reason).toBeInstanceOf(BuildInFlightError);
      }
    }

    const rows = await db
      .select()
      .from(builds)
      .where(eq(builds.environmentId, environmentId));
    expect(rows.filter((row) => row.status === "building")).toHaveLength(1);
    // The losers were not failed: they are still waiting their turn.
    expect(rows.filter((row) => row.status === "queued")).toHaveLength(2);
  });

  it("hands the oldest waiting build to the next drain", async () => {
    const environmentId = await seedEnvironment();
    const first = await service.create({
      environmentId,
      artifactPath: `${environmentId}/first.tar.gz`,
      manifest: { engineVersion: "0.56.0" },
    });
    const second = await service.create({
      environmentId,
      artifactPath: `${environmentId}/second.tar.gz`,
      manifest: { engineVersion: "0.57.0" },
    });

    expect((await service.nextQueued({ environmentId }))?.id).toBe(first.id);

    await service.transition({
      buildId: first.id,
      to: "building",
      expectedFrom: "queued",
    });
    // Publishes deploy in the order they were sent.
    expect((await service.nextQueued({ environmentId }))?.id).toBe(second.id);

    await service.transition({ buildId: second.id, to: "failed" });
    expect(await service.nextQueued({ environmentId })).toBeNull();
  });

  it("reports an unknown environment as not found", async () => {
    await expect(
      service.create({
        environmentId: "00000000-0000-4000-8000-000000000000",
        artifactPath: "x/y.tar.gz",
        manifest: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("BuildService.appendLog", () => {
  it("appends in order and keeps only the last 64KB", async () => {
    const { buildId } = await seedBuild("building");

    await service.appendLog({ buildId, chunk: "step 1\n" });
    await service.appendLog({ buildId, chunk: "step 2\n" });
    expect((await readBuild(buildId)).logTail).toBe("step 1\nstep 2\n");

    // Overflow the bound with a chunk that is itself the full size, then a
    // marker: the marker must survive and the oldest bytes must not.
    await service.appendLog({ buildId, chunk: "x".repeat(MAX_LOG_TAIL_CHARS) });
    await service.appendLog({ buildId, chunk: "TAIL" });

    const tail = (await readBuild(buildId)).logTail ?? "";
    expect(tail).toHaveLength(MAX_LOG_TAIL_CHARS);
    expect(tail.endsWith("TAIL")).toBe(true);
    expect(tail.includes("step 1")).toBe(false);
  });

  it("reports an unknown build as not found", async () => {
    await expect(
      service.appendLog({
        buildId: "00000000-0000-4000-8000-000000000000",
        chunk: "hello",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("BuildService reads", () => {
  it("lists one environment's builds newest first", async () => {
    const environmentId = await seedEnvironment();
    const first = await seedBuild("succeeded", environmentId);
    const second = await seedBuild("failed", environmentId);
    const third = await seedBuild("queued", environmentId);

    const { builds: rows } = await service.list({ environmentId });
    expect(rows.map((row) => row.id)).toEqual([
      third.buildId,
      second.buildId,
      first.buildId,
    ]);
    // The list is not the log viewer.
    expect(rows[0]).not.toHaveProperty("logTail");
  });

  it("scopes a get by environment, so a foreign build id reads as absent", async () => {
    const { buildId, environmentId } = await seedBuild("queued");
    const other = await seedEnvironment();

    expect(await service.get({ buildId, environmentId })).not.toBeNull();
    expect(await service.get({ buildId, environmentId: other })).toBeNull();
  });

  it("finds the unfinished build for an environment", async () => {
    const environmentId = await seedEnvironment();
    expect(await service.findActive({ environmentId })).toBeNull();

    const { buildId } = await seedBuild("pushing", environmentId);
    expect((await service.findActive({ environmentId }))?.id).toBe(buildId);

    await service.transition({ buildId, to: "failed", error: "registry 500" });
    expect(await service.findActive({ environmentId })).toBeNull();
  });
});
