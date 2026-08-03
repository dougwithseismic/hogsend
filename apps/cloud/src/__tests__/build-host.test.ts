import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SandboxBuildHostConfig } from "../env";
import { DockerImageStore } from "../images/docker";
import type {
  SandboxBuildSession,
  SandboxBuildSessionOptions,
} from "../images/sandbox-exec";
import type { ArtifactStore } from "../lib/artifacts";
import { LocalDiskArtifactStore } from "../lib/artifacts";
import type { BuildDeps, BuildPipelineResult } from "../pipeline/build";
import { runBuildOnHost } from "../pipeline/build-host";
import type { BuildRow, BuildService } from "../services/builds";

/**
 * The host selector's laws: local config = the pipeline untouched; sandbox
 * config = the session's exec injected into BOTH command seams; and the
 * sandbox is disposed on EVERY path out — the always-destroy law is proven
 * here at the wrapper, where the `finally` lives.
 */

const CONFIG: SandboxBuildHostConfig = {
  token: "railway-token",
  environmentId: "railway-env-1",
  idleTimeoutMinutes: 60,
};

const ENVIRONMENT_ID = randomUUID();
const BUILD_ID = randomUUID();

function fakeRow(): BuildRow {
  return {
    id: BUILD_ID,
    environmentId: ENVIRONMENT_ID,
    artifactPath: `${ENVIRONMENT_ID}/${BUILD_ID}.tar.gz`,
  } as BuildRow;
}

const fakeBuildService = {
  get: async () => fakeRow(),
} as unknown as BuildService;

/** An ArtifactStore that CAN presign, recording what it signed. */
function presigningStore() {
  const signed: { key: string; expires: number | undefined }[] = [];
  const store = {
    put: async () => {},
    get: async () => new Uint8Array(),
    remove: async () => {},
    removeEnvironment: async () => {},
    presignArtifactDownload: async (key: string, expires?: number) => {
      signed.push({ key, expires });
      return `https://bucket/signed/${key}`;
    },
  } satisfies ArtifactStore & {
    presignArtifactDownload: (k: string, e?: number) => Promise<string>;
  };
  return { store, signed };
}

function fakeSession() {
  const disposed: boolean[] = [];
  const exec: BuildDeps["exec"] = async () => ({
    code: 0,
    output: "",
    timedOut: false,
  });
  const session: SandboxBuildSession = {
    exec,
    dispose: async () => {
      disposed.push(true);
    },
  };
  return { session, disposed, exec };
}

const OK_RESULT: BuildPipelineResult = {
  buildId: BUILD_ID,
  status: "succeeded",
  steps: [],
  transitions: [],
};

let templateDir: string;

beforeAll(async () => {
  templateDir = await mkdtemp(join(tmpdir(), "hogsend-template-"));
  await writeFile(join(templateDir, "Dockerfile"), "FROM node:22\n");
  await mkdir(join(templateDir, "scripts"), { recursive: true });
  await writeFile(
    join(templateDir, "scripts", "preflight.sh"),
    "#!/usr/bin/env bash\necho gate\n",
  );
});

describe("runBuildOnHost", () => {
  it("with no sandbox config, runs the pipeline with the caller's deps untouched", async () => {
    const overrides = { templateDir };
    let seen: Partial<BuildDeps> | undefined;
    const result = await runBuildOnHost({ buildId: BUILD_ID }, overrides, {
      config: undefined,
      run: async (_input, deps) => {
        seen = deps;
        return OK_RESULT;
      },
    });
    expect(result).toBe(OK_RESULT);
    // Exactly the overrides — no injected exec, no injected image store.
    expect(seen).toEqual(overrides);
  });

  it("with sandbox config, injects the session's exec into both seams and disposes after", async () => {
    const { store, signed } = presigningStore();
    const { session, disposed, exec } = fakeSession();
    let sessionOptions: SandboxBuildSessionOptions | undefined;
    let seen: Partial<BuildDeps> | undefined;

    const result = await runBuildOnHost(
      { buildId: BUILD_ID },
      { templateDir },
      {
        config: CONFIG,
        buildService: fakeBuildService,
        artifacts: store,
        createSession: (options) => {
          sessionOptions = options;
          return session;
        },
        run: async (_input, deps) => {
          expect(disposed).toHaveLength(0); // alive while the pipeline runs
          seen = deps;
          return OK_RESULT;
        },
      },
    );

    expect(result).toBe(OK_RESULT);
    expect(disposed).toHaveLength(1);
    // The artifact was presigned by KEY, and the URL reached the session.
    expect(signed[0]?.key).toBe(`${ENVIRONMENT_ID}/${BUILD_ID}.tar.gz`);
    expect(sessionOptions?.artifactUrl).toContain("https://bucket/signed/");
    // The sandbox unpacks at the pipeline's own per-build workDir.
    expect(sessionOptions?.workDir.endsWith(BUILD_ID)).toBe(true);
    // Template contents were read and handed to the bootstrap.
    expect(sessionOptions?.templateDockerfile).toBe("FROM node:22\n");
    expect(sessionOptions?.templatePreflight).toContain("echo gate");
    // Both seams: the bare exec AND an image store built over it.
    expect(seen?.exec).toBe(exec);
    expect(seen?.images).toBeInstanceOf(DockerImageStore);
  });

  it("disposes the sandbox when the pipeline THROWS — the always-destroy law", async () => {
    const { store } = presigningStore();
    const { session, disposed } = fakeSession();
    await expect(
      runBuildOnHost(
        { buildId: BUILD_ID },
        { templateDir },
        {
          config: CONFIG,
          buildService: fakeBuildService,
          artifacts: store,
          createSession: () => session,
          run: async () => {
            throw new Error("boom mid-pipeline");
          },
        },
      ),
    ).rejects.toThrow("boom mid-pipeline");
    expect(disposed).toHaveLength(1);
  });

  it("disposes the sandbox when the pipeline FAILS a stage", async () => {
    const { store } = presigningStore();
    const { session, disposed } = fakeSession();
    const failed: BuildPipelineResult = {
      buildId: BUILD_ID,
      status: "failed",
      steps: ["precheck"],
      transitions: ["building", "failed"],
      failedStep: "precheck",
      error: "nope",
    };
    const result = await runBuildOnHost(
      { buildId: BUILD_ID },
      { templateDir },
      {
        config: CONFIG,
        buildService: fakeBuildService,
        artifacts: store,
        createSession: () => session,
        run: async () => failed,
      },
    );
    expect(result.status).toBe("failed");
    expect(disposed).toHaveLength(1);
  });

  it("refuses a store that cannot presign — a config error, not a runtime surprise", async () => {
    await expect(
      runBuildOnHost(
        { buildId: BUILD_ID },
        { templateDir },
        {
          config: CONFIG,
          buildService: fakeBuildService,
          artifacts: new LocalDiskArtifactStore(),
          run: async () => OK_RESULT,
        },
      ),
    ).rejects.toThrow(/cannot presign/);
  });
});
