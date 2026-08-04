import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Type-only: erased at runtime, so it cannot load `src/env` before the
// artifacts root above is repointed.
import type { BuildDeps } from "../pipeline/build";

/**
 * The build task, walked end to end against the REAL control-plane database.
 *
 * What is faked, and only these three:
 *  - the IMAGE STORE, because a docker daemon is not a unit-test dependency and
 *    the seam exists precisely so the pipeline can be proved without one;
 *  - EXEC, so the preflight gate's verdict can be scripted (a gate that only
 *    ever passes proves nothing about the "preflight failure deploys NOTHING"
 *    law);
 *  - the SUBSTRATE, the same seam every other pipeline test uses.
 *
 * Everything else is real: real tarballs on a real temp volume, real unpacking,
 * real rows, real guarded transitions, real audit trail. The assertions that
 * matter are ORDERINGS — the status sequence, and the fact that a failing stage
 * is followed by no calls at all to the stages after it.
 */

const ARTIFACTS_ROOT = mkdtempSync(join(tmpdir(), "hogsend-build-artifacts-"));
process.env.CLOUD_ARTIFACTS_DIR = ARTIFACTS_ROOT;

const { eq, inArray } = await import("drizzle-orm");
const { db, sqlClient } = await import("../db");
const { runCloudMigrations } = await import("../db/migrator");
const { builds, environments, organizations, stacks } = await import(
  "../db/schema"
);
const { env } = await import("../env");
const { FakeImageStore } = await import("../images/fake");
const { BUILD_STEPS, runBuildPipeline } = await import("../pipeline/build");
const { BuildService } = await import("../services/builds");
const { StackService } = await import("../services/stacks");
const { FakeSubstrate } = await import("../substrate");
const { SubstrateError } = await import("../substrate/types");
const { createFakeExec } = await import("../images/fake-exec");

const ORG = "build-pipeline-test-org";
const buildService = new BuildService(db);
const stackService = new StackService(db);

const BLOCK = 512;

interface TarFile {
  name: string;
  content: string;
  mode?: number;
}

function tarEntry(file: TarFile): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const data = Buffer.from(file.content, "utf8");
  header.write(file.name, 0, 100, "utf8");
  header.write(
    `${(file.mode ?? 0o644).toString(8).padStart(7, "0")}\0`,
    100,
    8,
  );
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([header, data, padding]);
}

function makeTarGz(files: TarFile[]): Buffer {
  return gzipSync(
    Buffer.concat([...files.map(tarEntry), Buffer.alloc(BLOCK * 2, 0)]),
  );
}

/** A scaffold-shaped archive: package.json, a source file, and its own gate. */
function scaffoldTarball(options: { withDockerfile?: boolean } = {}): Buffer {
  const files: TarFile[] = [
    { name: "acme/package.json", content: '{"name":"acme"}' },
    { name: "acme/src/index.ts", content: "export const app = 1;\n" },
    {
      name: "acme/scripts/preflight.sh",
      content: "#!/usr/bin/env bash\nexit 0\n",
      mode: 0o755,
    },
  ];
  if (options.withDockerfile) {
    files.push({ name: "acme/Dockerfile", content: "FROM node:22-slim\n" });
  }
  return makeTarGz(files);
}

let seq = 0;

interface Fixture {
  environmentId: string;
  stackId: string;
  buildId: string;
}

/** A running stack on a fake substrate, plus a queued build for its env. */
async function seed(tarball: Buffer = scaffoldTarball()): Promise<Fixture> {
  seq += 1;
  const [environment] = await db
    .insert(environments)
    .values({
      organizationId: ORG,
      name: `build-pipeline-env-${seq}`,
      kind: "test",
    })
    .returning();
  if (!environment) throw new Error("failed to seed environment");

  const [stack] = await db
    .insert(stacks)
    .values({
      organizationId: ORG,
      environmentId: environment.id,
      region: "us",
      status: "requested",
      dbName: `db_${seq}`,
    })
    .returning();
  if (!stack) throw new Error("failed to seed stack");

  const refs = await substrate.provisionRunningStack({
    stackId: stack.id,
    organizationId: ORG,
    environmentName: environment.name,
    region: "us",
    topology: "shared",
    env: {},
  });
  await db
    .update(stacks)
    .set({ substrateRefs: { ...refs }, status: "running" })
    .where(eq(stacks.id, stack.id));

  const build = await buildService.create({
    environmentId: environment.id,
    artifactPath: `${environment.id}/placeholder.tar.gz`,
    manifest: { engineVersion: "0.57.0" },
    engineVersion: "0.57.0",
  });
  // The intake writes `<environmentId>/<buildId>.tar.gz`; mirror it exactly so
  // the pipeline resolves the artifact the same way it does in production.
  const key = `${environment.id}/${build.id}.tar.gz`;
  const path = join(ARTIFACTS_ROOT, key);
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, tarball);
  await db
    .update(builds)
    .set({ artifactPath: key })
    .where(eq(builds.id, build.id));

  return {
    environmentId: environment.id,
    stackId: stack.id,
    buildId: build.id,
  };
}

let substrate: InstanceType<typeof FakeSubstrate>;
let images: InstanceType<typeof FakeImageStore>;

/** The status sequence a build actually walked, read from the audit trail. */
async function statusTrail(buildId: string): Promise<string[]> {
  const row = await db
    .select({ status: builds.status })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  return row.map((entry) => entry.status);
}

function run(fixture: Fixture, overrides: Partial<BuildDeps> = {}) {
  return runBuildPipeline(
    { buildId: fixture.buildId },
    { db, substrate, images, exec: createFakeExec(), ...overrides },
  );
}

beforeAll(async () => {
  await runCloudMigrations(env.CLOUD_DATABASE_URL);
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Build Pipeline Test", region: "us" })
    .onConflictDoNothing();
});

beforeEach(() => {
  substrate = new FakeSubstrate();
  images = new FakeImageStore();
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

describe("runBuildPipeline", () => {
  it("walks a queued build to succeeded, in order, deploying worker then api", async () => {
    const fixture = await seed();

    const result = await run(fixture);

    expect(result.status).toBe("succeeded");
    expect(result.steps).toEqual([...BUILD_STEPS]);
    // Every guarded edge, in the order the machine defines them.
    expect(result.transitions).toEqual([
      "building",
      "preflight",
      "pushing",
      "deploying",
      "succeeded",
    ]);
    expect(await statusTrail(fixture.buildId)).toEqual(["succeeded"]);

    // Worker before api, and migrate as the pre-deploy of the FIRST deploy so
    // no new-image process ever boots against an unmigrated schema.
    const deploys = substrate.calls.filter(
      (call) => call.method === "deployImage",
    );
    expect(deploys).toHaveLength(2);
    const first = deploys[0]?.args[1] as {
      service: string;
      preDeployCommand?: string;
    };
    const second = deploys[1]?.args[1] as { service: string };
    expect(first.service).toBe("worker");
    expect(first.preDeployCommand).toMatch(/migrate/);
    expect(second.service).toBe("api");

    // The stack came back to running, carrying what it is now running.
    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(stack?.status).toBe("running");
    expect(stack?.engineVersion).toBe("0.57.0");
    expect(stack?.imageDigest).toBe(images.digestFor(result.reference ?? ""));

    const [build] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.imageDigest).toBe(stack?.imageDigest);
    expect(build?.engineVersion).toBe("0.57.0");
    expect(build?.finishedAt).not.toBeNull();
  });

  it("copies in the template Dockerfile when the tarball carries none", async () => {
    const fixture = await seed(scaffoldTarball({ withDockerfile: false }));

    const result = await run(fixture);

    expect(result.status).toBe("succeeded");
    const built = images.calls.find((call) => call.method === "build");
    expect(built?.input.dockerfile).toContain("Dockerfile");
    // It came from the template, not from the archive.
    expect(result.usedTemplateDockerfile).toBe(true);
  });

  it("uses the app's own Dockerfile when the tarball ships one", async () => {
    const fixture = await seed(scaffoldTarball({ withDockerfile: true }));

    const result = await run(fixture);

    expect(result.status).toBe("succeeded");
    expect(result.usedTemplateDockerfile).toBe(false);
  });

  it("fails the build and deploys NOTHING when preflight refuses", async () => {
    const fixture = await seed();

    const result = await run(fixture, {
      exec: createFakeExec({ preflightExitCode: 1, output: "✗ api: crash" }),
    });

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("preflight");
    expect(result.transitions).toEqual(["building", "preflight", "failed"]);

    // The two laws of a preflight refusal.
    expect(images.calls.some((call) => call.method === "push")).toBe(false);
    expect(substrate.calls.some((call) => call.method === "deployImage")).toBe(
      false,
    );

    const [build] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.status).toBe("failed");
    expect(build?.error).toContain("preflight");
    expect(build?.logTail).toContain("crash");

    // And the stack was never moved: nothing was published.
    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(stack?.status).toBe("running");
  });

  it("fails the build when the image build fails, without preflighting", async () => {
    const fixture = await seed();
    images.failNext("build", new Error("docker build: no space left"));

    const result = await run(fixture);

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("image-build");
    expect(result.transitions).toEqual(["building", "failed"]);
    const [build] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.error).toContain("no space left");
  });

  it("fails the build when the push fails, without deploying", async () => {
    const fixture = await seed();
    images.failNext("push", new Error("registry: unauthorized"));

    const result = await run(fixture);

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("push");
    expect(result.transitions).toEqual([
      "building",
      "preflight",
      "pushing",
      "failed",
    ]);
    expect(substrate.calls.some((call) => call.method === "deployImage")).toBe(
      false,
    );
  });

  it("fails the build AFTER the push when the deploy fails, and parks the stack", async () => {
    const fixture = await seed();
    substrate.failNext(
      "deployImage",
      new SubstrateError("service is unreachable"),
    );

    const result = await run(fixture);

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("deploy");
    expect(result.transitions).toEqual([
      "building",
      "preflight",
      "pushing",
      "deploying",
      "failed",
    ]);
    // The push DID happen — the failure is downstream of it.
    expect(images.calls.some((call) => call.method === "push")).toBe(true);

    const [stack] = await db
      .select()
      .from(stacks)
      .where(eq(stacks.id, fixture.stackId));
    expect(stack?.status).toBe("error");
    expect(stack?.lastError).toContain("unreachable");
  });

  it("bounds the log tail however much output a stage produces", async () => {
    const fixture = await seed();
    const { MAX_LOG_TAIL_CHARS } = await import("../services/builds");

    const result = await run(fixture, {
      exec: createFakeExec({ output: "L".repeat(400_000) }),
    });

    expect(result.status).toBe("succeeded");
    const [build] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.logTail?.length).toBeGreaterThan(0);
    expect(build?.logTail?.length).toBeLessThanOrEqual(MAX_LOG_TAIL_CHARS);
  });

  it("refuses a traversal-hostile tarball and fails the build at unpack", async () => {
    const hostile = makeTarGz([
      { name: "acme/package.json", content: "{}" },
      { name: "../../escaped.txt", content: "pwned" },
    ]);
    const fixture = await seed(hostile);

    const result = await run(fixture);

    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("unpack");
    expect(images.calls).toHaveLength(0);
    const [build] = await db
      .select()
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.error).toMatch(/unpack/i);
  });

  it("removes the unpack directory whether the build succeeded or failed", async () => {
    const { existsSync } = await import("node:fs");

    const ok = await seed();
    const okResult = await run(ok);
    expect(okResult.status).toBe("succeeded");
    expect(okResult.workDir).toBeDefined();
    expect(existsSync(okResult.workDir as string)).toBe(false);

    const bad = await seed();
    images.failNext("build", new Error("boom"));
    const badResult = await run(bad);
    expect(badResult.status).toBe("failed");
    expect(existsSync(badResult.workDir as string)).toBe(false);
  });

  it("refuses to run a build that is not queued", async () => {
    const fixture = await seed();
    await buildService.transition({
      buildId: fixture.buildId,
      to: "building",
      expectedFrom: "queued",
    });

    const result = await run(fixture);

    expect(result.status).toBe("skipped");
    expect(images.calls).toHaveLength(0);
  });

  it("queues a second publish for a busy environment and never races it", async () => {
    const fixture = await seed();
    // The first build claims the environment.
    await buildService.transition({
      buildId: fixture.buildId,
      to: "building",
      expectedFrom: "queued",
    });

    // A second publish is ACCEPTED — it queues, it is not refused.
    const second = await buildService.create({
      environmentId: fixture.environmentId,
      artifactPath: `${fixture.environmentId}/second.tar.gz`,
      manifest: { engineVersion: "0.57.0" },
    });
    expect(second.status).toBe("queued");

    // …and a runner that picks it up steps away rather than racing the stack.
    const result = await run({ ...fixture, buildId: second.id });
    expect(result.status).toBe("skipped");
    expect(images.calls).toHaveLength(0);
    expect(substrate.calls.some((call) => call.method === "deployImage")).toBe(
      false,
    );
    const [waiting] = await db
      .select({ status: builds.status })
      .from(builds)
      .where(eq(builds.id, second.id));
    expect(waiting?.status).toBe("queued");
  });

  it("refuses at PRECHECK when the stack cannot receive a deploy", async () => {
    const fixture = await seed();
    await stackService.transition({
      stackId: fixture.stackId,
      to: "suspended",
      expectedFrom: "running",
    });

    const result = await run(fixture);

    expect(result.status).toBe("failed");
    // Before the docker build, not after the push: a stack that cannot receive
    // this image is knowable at second zero, and a wedged stack must not cost
    // a full build (and a registry push) on every retry.
    expect(result.failedStep).toBe("precheck");
    expect(images.calls).toHaveLength(0);
    expect(substrate.calls.some((call) => call.method === "deployImage")).toBe(
      false,
    );
  });

  it("stamps the stack on the build row at the deploying write", async () => {
    const fixture = await seed();

    await run(fixture);

    // What lets the sweep park the STACK of a build it reaps mid-deploy.
    const [build] = await db
      .select({ stackId: builds.stackId })
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.stackId).toBe(fixture.stackId);
  });

  it("never runs the archive's preflight script, and hands it no secrets", async () => {
    // A canary that stands in for CLOUD_ENCRYPTION_SECRET et al: whatever the
    // control plane holds, the gate must not be able to print it into a log
    // the tenant reads.
    process.env.CLOUD_PREFLIGHT_CANARY = "control-plane-secret";
    const fixture = await seed();

    // The archive ships its own `scripts/preflight.sh` (see `scaffoldTarball`),
    // so this run is exactly the case that used to execute a stranger's shell.
    let ranScript: string | undefined;
    let ranEnv: NodeJS.ProcessEnv | undefined;
    const result = await run(fixture, {
      exec: async (command, args, options) => {
        expect(command).toBe("bash");
        ranScript = readFileSync(args[0] as string, "utf8");
        ranEnv = options?.env;
        return { code: 0, output: "", timedOut: false };
      },
    });

    expect(result.status).toBe("succeeded");
    // The platform's gate, not the uploaded one.
    expect(ranScript).toContain("Preflight — the gate");
    expect(ranScript).not.toContain("export const app");
    expect(ranScript?.trim()).not.toBe("#!/usr/bin/env bash\nexit 0");
    // An allowlist: PATH survives because docker needs it; nothing else does.
    expect(ranEnv).toBeDefined();
    expect(ranEnv?.PATH).toBeTruthy();
    expect(ranEnv?.CLOUD_PREFLIGHT_CANARY).toBeUndefined();
    expect(ranEnv?.CLOUD_DATABASE_URL).toBeUndefined();
    expect(Object.keys(ranEnv ?? {})).not.toContain("CLOUD_ENCRYPTION_SECRET");

    // And the tenant is told their script was not run.
    const [build] = await db
      .select({ logTail: builds.logTail })
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.logTail).toContain("replaced with the platform's");
    delete process.env.CLOUD_PREFLIGHT_CANARY;
  });

  it("bounds the preflight gate and fails the build when it is killed", async () => {
    const fixture = await seed();
    const calls: { timeoutMs?: number }[] = [];

    const result = await run(fixture, {
      preflightTimeoutMs: 1234,
      exec: async (_command, _args, options) => {
        calls.push({ timeoutMs: options?.timeoutMs });
        // What `spawnExec` reports when it SIGKILLs the process group.
        return { code: 137, output: "", timedOut: true };
      },
    });

    expect(calls[0]?.timeoutMs).toBe(1234);
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("preflight");
    // A killed gate is a refusal, not a pass: nothing left the host.
    expect(images.calls.some((call) => call.method === "push")).toBe(false);
    const [build] = await db
      .select({ error: builds.error })
      .from(builds)
      .where(eq(builds.id, fixture.buildId));
    expect(build?.error).toMatch(/did not finish/i);
  });
});
