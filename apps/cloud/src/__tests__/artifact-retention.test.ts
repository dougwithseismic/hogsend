import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ARTIFACT RETENTION: who deletes a tenant's uploaded source, and when.
 *
 * A publish tarball is tenant SOURCE CODE sitting on a shared control plane, up
 * to 64MB of it per publish. Nothing about the build machine needs it once the
 * attempt is over — the log tail is the diagnosis surface — so the two moments
 * that end an artifact's usefulness must actually delete it:
 *
 *  - a build reaching a TERMINAL status (`succeeded` or `failed`), and
 *  - the environment being REMOVED, which cascades every `builds` row away and
 *    would otherwise leave files referenced by nothing at all.
 *
 * Tested against the real database and a real temp volume, because the claim is
 * about a file on disk and a mocked `fs` would certify the intention instead of
 * the behaviour. The artifacts root is repointed BEFORE `src/env.ts` loads, so
 * the suite never writes into the repository.
 */
const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-retention-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { eq, inArray } = await import("drizzle-orm");
const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, environments, organizations } = await import("../db/schema");
const { env } = await import("../env");
const { BuildService } = await import("../services/builds");
const { EnvironmentService } = await import("../services/environments");

const ORG = "artifact-retention-test-org";
const service = new BuildService(db);
const environmentService = new EnvironmentService(db);

let seq = 0;

async function seedEnvironment(): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(environments)
    .values({ organizationId: ORG, name: `retention-env-${seq}`, kind: "test" })
    .returning();
  if (!row) throw new Error("failed to seed environment");
  return row.id;
}

/** A queued build whose artifact is really on disk, exactly as intake writes it. */
async function seedBuildWithArtifact(
  environmentId: string,
): Promise<{ buildId: string; path: string }> {
  const buildId = randomUUID();
  const key = `${environmentId}/${buildId}.tar.gz`;
  const path = join(ARTIFACTS_ROOT, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Uint8Array([0x1f, 0x8b, 0x00, 0x00]));

  await service.create({
    id: buildId,
    environmentId,
    artifactPath: key,
    manifest: { engineVersion: "0.57.0" },
  });
  expect(existsSync(path)).toBe(true);
  return { buildId, path };
}

async function cleanup(): Promise<void> {
  await db.delete(organizations).where(inArray(organizations.id, [ORG]));
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await cleanup();
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Artifact Retention Test", region: "us" });
});

afterAll(async () => {
  await cleanup();
  await sqlClient.end();
});

describe("artifact retention — a finished build keeps no source", () => {
  it("deletes the tarball when a build SUCCEEDS", async () => {
    const environmentId = await seedEnvironment();
    const { buildId, path } = await seedBuildWithArtifact(environmentId);

    for (const to of [
      "building",
      "preflight",
      "pushing",
      "deploying",
    ] as const) {
      await service.transition({ buildId, to });
      // Still working: the artifact is the input to the stage that follows.
      expect(existsSync(path)).toBe(true);
    }

    await service.transition({ buildId, to: "succeeded" });
    expect(existsSync(path)).toBe(false);

    // The RECORD survives the artifact — a build is the history of a publish.
    const [row] = await db.select().from(builds).where(eq(builds.id, buildId));
    expect(row?.status).toBe("succeeded");
    expect(row?.artifactPath).toBe(`${environmentId}/${buildId}.tar.gz`);
  });

  it("deletes the tarball when a build FAILS", async () => {
    const environmentId = await seedEnvironment();
    const { buildId, path } = await seedBuildWithArtifact(environmentId);

    await service.transition({
      buildId,
      to: "failed",
      error: "the preflight gate refused the image",
    });

    expect(existsSync(path)).toBe(false);
  });

  it("keeps the tarball of a build that is still queued", async () => {
    const environmentId = await seedEnvironment();
    const running = await seedBuildWithArtifact(environmentId);
    const waiting = await seedBuildWithArtifact(environmentId);

    await service.transition({ buildId: running.buildId, to: "building" });
    await service.transition({ buildId: running.buildId, to: "failed" });

    // One build ending must not disarm the one queued behind it: that build
    // has not run yet, and its tarball is the only copy of what it publishes.
    expect(existsSync(running.path)).toBe(false);
    expect(existsSync(waiting.path)).toBe(true);
  });
});

describe("artifact retention — a removed environment keeps no source", () => {
  it("removes the environment's artifact directory with the environment", async () => {
    const environmentId = await seedEnvironment();
    const first = await seedBuildWithArtifact(environmentId);
    const second = await seedBuildWithArtifact(environmentId);
    const dir = join(ARTIFACTS_ROOT, environmentId);

    await environmentService.remove({ organizationId: ORG, environmentId });

    // The rows cascaded away; without this the files would be referenced by
    // nothing at all, which is worse than an orphan — it is unattributable
    // tenant source retained forever.
    expect(
      await db
        .select()
        .from(builds)
        .where(eq(builds.environmentId, environmentId)),
    ).toHaveLength(0);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps another environment's artifacts", async () => {
    const doomed = await seedEnvironment();
    const spared = await seedEnvironment();
    await seedBuildWithArtifact(doomed);
    const kept = await seedBuildWithArtifact(spared);

    await environmentService.remove({
      organizationId: ORG,
      environmentId: doomed,
    });

    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(join(ARTIFACTS_ROOT, spared))).toBe(true);
  });
});
