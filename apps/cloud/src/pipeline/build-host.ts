import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  env,
  type SandboxBuildHostConfig,
  sandboxBuildHostConfig,
} from "../env";
import { DockerImageStore } from "../images/docker";
import {
  createSandboxBuildSession,
  RailwaySandboxApi,
  type SandboxApi,
  type SandboxBuildSession,
  type SandboxBuildSessionOptions,
} from "../images/sandbox-exec";
import {
  type ArtifactStore,
  artifactsRoot,
  getArtifactStore,
  PRESIGNED_ARTIFACT_URL_TTL_SECONDS,
  supportsPresignedDownload,
} from "../lib/artifacts";
import {
  type BuildService,
  buildService as defaultBuildService,
} from "../services/builds";
import { NotFoundError } from "../services/errors";
import { RailwayClient } from "../substrate/railway/client";
import {
  type BuildDeps,
  type BuildPipelineResult,
  runBuildPipeline,
  scaffoldTemplateDir,
} from "./build";

/**
 * The build-host selector (PRD 14 task 3): every runner (the Hatchet task,
 * the in-process queue, the sweep) starts a build through here, so "which
 * machine runs the commands" is one fact in one place.
 *
 * `local` (the default) is `runBuildPipeline` exactly as before — same deps,
 * same `spawnExec`. `sandbox` wraps the same pipeline in a per-build Railway
 * Sandbox session and injects its `ExecFn` into BOTH command seams (the bare
 * `exec` the preflight gate uses AND a `DockerImageStore` built over it, so
 * `docker build`/`push`/`inspect` run remotely too). The seven stages are
 * untouched either way.
 *
 * The `finally` is the always-destroy law: whatever the pipeline returned or
 * threw, the sandbox is torn down before this function settles. A leaked
 * sandbox is a running VM nobody is watching.
 */

/** Test seam: everything `runBuildOnHost` would otherwise resolve globally. */
export interface BuildHostWiring {
  /** `undefined` = local. Present = sandbox. Omitted = read the env. */
  config?: SandboxBuildHostConfig;
  buildService?: BuildService;
  artifacts?: ArtifactStore;
  createApi?: (config: SandboxBuildHostConfig) => SandboxApi;
  createSession?: (options: SandboxBuildSessionOptions) => SandboxBuildSession;
  run?: typeof runBuildPipeline;
}

export async function runBuildOnHost(
  input: { buildId: string },
  overrides: Partial<BuildDeps> = {},
  wiring: BuildHostWiring = {},
): Promise<BuildPipelineResult> {
  const run = wiring.run ?? runBuildPipeline;
  const config = "config" in wiring ? wiring.config : sandboxBuildHostConfig();
  if (!config) return await run(input, overrides);

  // The artifact enters the sandbox by presigned download, never by relaying
  // the bytes through this process — so the store must be able to mint one.
  // The boot guard already ties sandbox mode to a bucket; this is the same
  // refusal for a test or an override that wired stores by hand.
  const artifacts = wiring.artifacts ?? getArtifactStore();
  if (!supportsPresignedDownload(artifacts)) {
    throw new Error(
      "CLOUD_BUILD_HOST=sandbox requires the S3 artifact store — the " +
        "local-disk store cannot presign a download URL for the sandbox " +
        "to fetch. Configure the artifact bucket or set " +
        "CLOUD_BUILD_HOST=local.",
    );
  }

  const buildService = wiring.buildService ?? defaultBuildService;
  const row = await buildService.get({ buildId: input.buildId });
  if (!row) throw new NotFoundError("Build", input.buildId);
  const artifactUrl = await artifacts.presignArtifactDownload(
    row.artifactPath,
    PRESIGNED_ARTIFACT_URL_TTL_SECONDS,
  );

  // The sandbox reproduces the pipeline's tree at the pipeline's own paths,
  // so these MUST match `defaultDeps()` in `build.ts` (or the caller's
  // overrides) — a divergent workDir would have every argv point at files
  // the sandbox unpacked somewhere else.
  const workRoot = overrides.workRoot ?? join(artifactsRoot(), ".work");
  const workDir = join(workRoot, input.buildId);
  const templateDir = overrides.templateDir ?? scaffoldTemplateDir();
  const [templateDockerfile, templatePreflight] = await Promise.all([
    readFile(join(templateDir, "Dockerfile"), "utf8"),
    readFile(join(templateDir, "scripts", "preflight.sh"), "utf8"),
  ]);

  // The push credentials that already exist for the registry: the same pair
  // `getSubstrate()` hands Railway for pulls. The login server is the HOST
  // of the registry prefix (`ghcr.io/withseismic` → `ghcr.io`). Enforced as
  // a pair elsewhere (`getSubstrate` refuses half of one); here a missing
  // pair simply means no login, which is right for a credential-less
  // registry and for the registry-less local mode.
  const registry = env.CLOUD_IMAGE_REGISTRY?.replace(/\/+$/, "");
  const registryLogin =
    registry && env.CLOUD_REGISTRY_USERNAME && env.CLOUD_REGISTRY_PASSWORD
      ? {
          // biome-ignore lint/style/noNonNullAssertion: split always yields one part
          server: registry.split("/")[0]!,
          username: env.CLOUD_REGISTRY_USERNAME,
          password: env.CLOUD_REGISTRY_PASSWORD,
        }
      : undefined;

  const api =
    wiring.createApi?.(config) ??
    new RailwaySandboxApi(new RailwayClient({ token: config.token }));
  const session = (wiring.createSession ?? createSandboxBuildSession)({
    api,
    environmentId: config.environmentId,
    ...(config.region ? { region: config.region } : {}),
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    workDir,
    artifactUrl,
    templateDockerfile,
    templatePreflight,
    ...(registryLogin ? { registryLogin } : {}),
  });

  try {
    // Both seams, one host: the image store's docker commands and the
    // preflight's bash all run in the same sandbox, against the same tree
    // and the same daemon. Caller overrides still win (`...overrides` last)
    // so a test that injects its own fakes is untouched by host selection.
    const images = new DockerImageStore({
      exec: session.exec,
      registry: env.CLOUD_IMAGE_REGISTRY,
    });
    return await run(input, {
      exec: session.exec,
      images,
      ...overrides,
    });
  } finally {
    // ALWAYS — success, stage failure, throw. Never throws itself.
    await session.dispose();
  }
}
