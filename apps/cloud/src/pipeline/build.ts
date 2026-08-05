import { access, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { CloudDb } from "../db";
import { db as defaultDb } from "../db";
import { environments, stacks } from "../db/schema";
import { env } from "../env";
import { type ExecFn, spawnExec } from "../images/exec";
import { getImageStore } from "../images/index";
import { tenantImageTag } from "../images/tags";
import type { ImageStore } from "../images/types";
import {
  type ArtifactStore,
  artifactsRoot,
  getArtifactStore,
} from "../lib/artifacts";
import { readStackRefs } from "../lib/stack-refs";
import { extractTarball, resolveAppRoot } from "../lib/tarball";
import { writeAudit } from "../services/audit";
import {
  type BuildRow,
  BuildService,
  type BuildStatus,
  buildService as defaultBuildService,
} from "../services/builds";
import {
  BuildInFlightError,
  IllegalBuildTransitionError,
  NotFoundError,
} from "../services/errors";
import { StackService } from "../services/stacks";
import {
  getSubstrate,
  type StackRefs,
  type SubstrateProvider,
} from "../substrate";

/**
 * The build pipeline: one queued publish artifact walked to a deployed image.
 *
 * The laws this module exists to hold (PRD 08):
 *
 *  - **The state machine is the only narrative.** Every stage boundary is a
 *    `BuildService.transition()` on a GUARDED edge, so the row says what is
 *    happening while it happens, and an illegal jump is refused by Postgres
 *    rather than by this file's good intentions.
 *  - **Preflight failure deploys NOTHING.** The gate sits between the image
 *    existing and the image leaving the host: a refusal ends the build before
 *    `push`, so a broken image never reaches a registry, let alone a tenant.
 *  - **Nothing out of the archive RUNS on the build host.** The uploaded tree
 *    is data: it is unpacked, and it is fed to `docker build`, which confines
 *    it to a container. The one script this pipeline executes directly is the
 *    platform's own preflight gate, run with an allowlisted environment and a
 *    timeout — because this process holds the credentials of every tenant, and
 *    its output is streamed to the dashboard of the one who published.
 *  - **A failure is legible.** Every stage's output is streamed into the build's
 *    bounded log tail, and the terminal `failed` transition names the STAGE.
 *    "It didn't work" is not an acceptable answer to a customer who published.
 *  - **One attempt per row.** A build that is not `queued` is left alone —
 *    `builds` records ONE attempt and a retry is a new row (see
 *    `services/builds.ts`), so the task takes no retries and cannot half-replay
 *    a deploy.
 *  - **The temp tree always goes.** The unpack directory is removed in a
 *    `finally`, success or failure, because a build host that keeps every
 *    tenant's source tree is both a disk-space bug and a data-retention one.
 */

/** The stages, in the order a healthy build walks them. */
export const BUILD_STEPS = [
  "precheck",
  "unpack",
  "image-build",
  "preflight",
  "push",
  "deploy",
  "finish",
] as const;

export type BuildStep = (typeof BUILD_STEPS)[number];

/** The actor recorded on every row this pipeline writes. */
export const BUILDER_ACTOR = "builder";

/**
 * The migrate command run as the deploy's pre-deploy hook. It is the scaffold
 * Dockerfile's migrate run mode VERBATIM — `tsx`, never `pnpm` (pnpm's
 * deps-status check mutates a root-owned node_modules as an unprivileged user
 * and EACCES-crash-loops; the template Dockerfile documents the same law).
 */
export const MIGRATE_PRE_DEPLOY_COMMAND = "tsx scripts/migrate.ts";

/**
 * The worker run mode's start command, VERBATIM from the scaffold Dockerfile
 * (whose default CMD is the api). Provision hands it to the substrate so the
 * worker service actually executes journeys instead of booting a second api.
 */
export const WORKER_START_COMMAND = "node dist/worker.js";

/**
 * The in-memory log tail, flushed to the row at every stage boundary.
 *
 * Bounded HERE as well as in Postgres (`right(…, 64KB)`) because the two bounds
 * protect different things: this one keeps a chatty docker build off the
 * worker's heap, the database's keeps the row — and the dashboard — readable.
 */
export const MAX_PENDING_LOG_CHARS = 32 * 1024;

/**
 * How long the precheck waits for a stack that is not `running` YET.
 *
 * It exists for exactly one shape (PRD 15): under
 * `CLOUD_PROVISION_ON=first-publish` the very first publish is what ASKS for
 * the substrate, so the intake promotes the stack and this pipeline arrives
 * while the provisioner is still building it. Failing there would make the
 * first publish of every new tenant fail by design.
 *
 * Twenty minutes because a cold provision is minutes of substrate work plus the
 * provision pipeline's own ten-minute health wait, and a stack that has not
 * come up inside that is not slow — it is parked, and the build should say so
 * rather than hold a queue slot forever.
 */
export const DEFAULT_STACK_WAIT_MS = 20 * 60_000;

/** How often the wait re-reads the stack's status. */
export const DEFAULT_STACK_WAIT_POLL_MS = 5_000;

/**
 * Statuses the wait treats as "still coming". Everything else is answered
 * immediately: `running` succeeds, and `error`/`suspended`/`destroying`/
 * `destroyed` are stacks nothing is bringing up, so waiting on one would only
 * turn a clear failure into a twenty-minute one.
 */
const STACK_WAIT_STATUSES = new Set(["deferred", "requested", "provisioning"]);

/** Deploy order. Worker first: see `deployStack` for why. */
const DEPLOY_ORDER = ["worker", "api"] as const;

export interface BuildDeps {
  db: CloudDb;
  buildService: BuildService;
  stackService: StackService;
  substrate: SubstrateProvider;
  images: ImageStore;
  exec: ExecFn;
  /**
   * `packages/create-hogsend/template` — the Dockerfile FALLBACK (used when the
   * archive ships none) and the preflight gate's only source (it always wins;
   * see {@link installPreflightScript}).
   */
  templateDir: string;
  /**
   * Where artifact bytes come from. Injected so tests can substitute a store;
   * the seam is also what lets the upload land on `cloud-app` and the build
   * run on `cloud-worker` once the store is not this container's disk.
   */
  artifacts: ArtifactStore;
  /** Where unpack directories are created. One per build, removed after. */
  workRoot: string;
  /** Ceiling on the preflight gate. See {@link DEFAULT_PREFLIGHT_TIMEOUT_MS}. */
  preflightTimeoutMs: number;
  /** Ceiling on the first-publish wait. See {@link DEFAULT_STACK_WAIT_MS}. */
  stackWaitMs: number;
  /** Gap between two stack-status reads while waiting. */
  stackWaitPollMs: number;
  /** Injected so a test can exhaust the wait without spending the wall clock. */
  sleep: (ms: number) => Promise<void>;
}

export interface BuildPipelineResult {
  buildId: string;
  status: "succeeded" | "failed" | "skipped";
  /** Stages actually entered, in order. */
  steps: BuildStep[];
  /** Build statuses actually written, in order — the machine's own trail. */
  transitions: BuildStatus[];
  failedStep?: BuildStep;
  error?: string;
  /** The pushed image reference, once there is one. */
  reference?: string;
  imageDigest?: string | null;
  /** True when the archive shipped no Dockerfile and the template's was used. */
  usedTemplateDockerfile?: boolean;
  /** The unpack directory this run used. Removed by the time this returns. */
  workDir?: string;
  /** Why a non-`queued` build was left alone. */
  reason?: string;
}

/**
 * `packages/create-hogsend/template`, resolved from this module for a worker
 * running out of the repo. `CLOUD_SCAFFOLD_TEMPLATE_DIR` overrides it for a
 * deployment that carries the template somewhere else.
 */
export function scaffoldTemplateDir(): string {
  if (env.CLOUD_SCAFFOLD_TEMPLATE_DIR) {
    return resolve(env.CLOUD_SCAFFOLD_TEMPLATE_DIR);
  }
  // apps/cloud/src/pipeline → apps/cloud/src → apps/cloud → apps → repo root.
  // Assembled from `dirname` rather than `new URL("…", import.meta.url)`: the
  // Next bundler treats that form as a static import specifier and fails the
  // build trying to resolve a directory that is not a module.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(
    here,
    "..",
    "..",
    "..",
    "..",
    "packages/create-hogsend/template",
  );
}

function defaultDeps(): BuildDeps {
  return {
    db: defaultDb,
    buildService: defaultBuildService,
    stackService: new StackService(),
    // Resolved lazily per run for the same reason provisioning does it: a
    // misconfigured substrate must fail a BUILD, not a module import.
    substrate: getSubstrate(),
    images: getImageStore(),
    exec: spawnExec,
    templateDir: scaffoldTemplateDir(),
    artifacts: getArtifactStore(),
    workRoot: join(artifactsRoot(), ".work"),
    preflightTimeoutMs: DEFAULT_PREFLIGHT_TIMEOUT_MS,
    stackWaitMs: DEFAULT_STACK_WAIT_MS,
    stackWaitPollMs: DEFAULT_STACK_WAIT_POLL_MS,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The build's log, buffered and flushed at stage boundaries.
 *
 * Not written per chunk: a docker build emits thousands of lines, and one
 * UPDATE each would turn the log into the pipeline's dominant cost. Overflow
 * drops from the HEAD, which is what a tail means.
 */
class BuildLog {
  private pending = "";

  constructor(
    private readonly service: BuildService,
    private readonly buildId: string,
  ) {}

  append(chunk: string): void {
    this.pending = (this.pending + chunk).slice(-MAX_PENDING_LOG_CHARS);
  }

  line(text: string): void {
    this.append(`${text}\n`);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const chunk = this.pending;
    this.pending = "";
    // A log write must never be able to fail a build that otherwise worked.
    await this.service
      .appendLog({ buildId: this.buildId, chunk })
      .catch(() => {});
  }
}

/**
 * Walk one build. Returns rather than throws on a stage failure: the row is
 * already parked in `failed` with the stage name by then, and both callers (a
 * durable task and an in-process queue) want a value, not an exception.
 */
export async function runBuildPipeline(
  input: { buildId: string },
  overrides: Partial<BuildDeps> = {},
): Promise<BuildPipelineResult> {
  const deps: BuildDeps = { ...defaultDeps(), ...overrides };
  // A caller that repoints the DATABASE means every service too; rebuilding
  // them here is what stops a test from writing rows through two pools.
  if (overrides.db && !overrides.buildService) {
    deps.buildService = new BuildService(deps.db);
  }
  if (overrides.db && !overrides.stackService) {
    deps.stackService = new StackService(deps.db);
  }

  const { buildId } = input;

  const row = await deps.buildService.get({ buildId });
  if (!row) throw new NotFoundError("Build", buildId);

  // ONE attempt per row. A build in any other status is either finished, or
  // being walked by another worker, or was interrupted — and an interrupted
  // build is reaped by the sweep, never resumed mid-machine here.
  if (row.status !== "queued") {
    return {
      buildId,
      status: "skipped",
      steps: [],
      transitions: [],
      reason: `build is ${row.status}, not queued`,
    };
  }

  const workDir = join(deps.workRoot, buildId);
  // The store's bytes staged as a real file for `extractTarball` — a sibling
  // of the unpack tree, NOT inside it, so the archive never sits in the docker
  // build context it produced. Removed in the same `finally` as the tree.
  const archiveScratch = `${workDir}.artifact.tar.gz`;
  const log = new BuildLog(deps.buildService, buildId);
  const steps: BuildStep[] = [];
  const transitions: BuildStatus[] = [];
  let current: BuildStep = "precheck";
  /** Set once the stack is `publishing` and not yet moved back. */
  let stackPublishing: string | null = null;

  const advance = async (
    to: BuildStatus,
    from: BuildStatus,
    extra: {
      imageDigest?: string;
      engineVersion?: string;
      stackId?: string;
    } = {},
  ): Promise<void> => {
    await deps.buildService.transition({
      buildId,
      to,
      expectedFrom: from,
      actor: BUILDER_ACTOR,
      ...extra,
    });
    transitions.push(to);
  };

  try {
    // ---- precheck ---------------------------------------------------------
    current = "precheck";
    steps.push(current);
    // CLAIMING the build, not merely reporting progress. The guarded write is
    // what makes two runners (the enqueue path and the sweep, or two replicas)
    // safe: exactly one wins `queued → building`, and the loser must step away
    // rather than fail a build somebody else is walking.
    //
    // The claim is also where the QUEUE is honoured. `queued` rows accumulate
    // freely (a publish is never refused for a busy environment), so this write
    // can meet the single-flight index instead of the transition table: the
    // environment already has a build running. That is not a failure of THIS
    // build — it waits, still queued, for the next drain.
    try {
      await advance("building", "queued");
    } catch (error) {
      if (error instanceof BuildInFlightError) {
        return {
          buildId,
          status: "skipped",
          steps: [],
          transitions: [],
          reason: "another build is running for this environment",
        };
      }
      if (error instanceof IllegalBuildTransitionError) {
        return {
          buildId,
          status: "skipped",
          steps: [],
          transitions: [],
          reason: "another builder claimed this build",
        };
      }
      throw error;
    }

    // Is there anything to deploy ONTO? Asked here, before minutes of docker,
    // rather than only at the deploy step. A stack that is not `running` —
    // suspended, errored, or wedged in `publishing` by a worker that died
    // mid-deploy — cannot receive this image, and discovering that after a
    // build, a gate and a registry push means every retry burns the whole
    // pipeline before saying the one thing it knew at second zero. The check is
    // ADVISORY: the authority is still the guarded `running → publishing`
    // transition at the deploy step, which is what makes the race safe.
    // …and if there is not one YET, WAIT for it. Under
    // `CLOUD_PROVISION_ON=first-publish` (PRD 15) the upload that queued this
    // build is what asked for the substrate, so arriving before the stack is
    // up is the ORDINARY first publish, not a failure. The wait is bounded and
    // only covers statuses something is actively driving; every other status
    // fails here exactly as it always did. The build stays `building` while it
    // waits — the phase a poller reads is the STACK's, which
    // `GET /api/builds/:id` carries for exactly this reason.
    await loadRunningStack(deps, row.environmentId, log);

    // ---- unpack -----------------------------------------------------------
    current = "unpack";
    steps.push(current);
    // Bytes through the STORE, not a path: the artifact may live on another
    // container's upload (or, task 2, in object storage), so the pipeline
    // fetches and writes its own scratch copy before unpacking. `unpack`
    // itself is unchanged — same extractor, same refusals.
    const artifactBytes = await deps.artifacts.get(row.artifactPath);
    await mkdir(workDir, { recursive: true });
    await writeFile(archiveScratch, artifactBytes);
    const extracted = await extractTarball({
      archivePath: archiveScratch,
      destDir: workDir,
    });
    const appRoot = await resolveAppRoot(workDir);
    log.line(
      `unpacked ${extracted.files} files (${extracted.bytes} bytes) from ${row.artifactPath}`,
    );

    // ---- image-build ------------------------------------------------------
    current = "image-build";
    steps.push(current);
    const dockerfile = join(appRoot, "Dockerfile");
    const usedTemplateDockerfile = !(await pathExists(dockerfile));
    if (usedTemplateDockerfile) {
      // The generic scaffold Dockerfile (PRD 08 task 1). Copied INTO the
      // context rather than referenced in place: `.dockerignore` and relative
      // COPY paths resolve against the context, and a Dockerfile living outside
      // it is a class of confusing failures for no benefit.
      await copyFile(join(deps.templateDir, "Dockerfile"), dockerfile);
      log.line("no Dockerfile in the archive — using the scaffold template's");
    }

    const tag = tenantImageTag({ environmentId: row.environmentId, buildId });
    const built = await deps.images.build({
      contextDir: appRoot,
      dockerfile,
      tag,
      onOutput: (chunk) => log.append(chunk),
    });
    log.line(`built ${built.reference}`);
    await log.flush();

    // ---- preflight --------------------------------------------------------
    // The gate. It runs against the image that was just built and BEFORE the
    // push, which is what makes "preflight failure deploys nothing" structural
    // rather than a promise.
    current = "preflight";
    steps.push(current);
    await advance("preflight", "building");

    const gate = await installPreflightScript(appRoot, deps.templateDir);
    if (gate.replacedArchiveCopy) {
      log.line(
        "the archive's scripts/preflight.sh was replaced with the platform's — an uploaded script is never executed on the build host",
      );
    }
    const preflight = await runPreflight({
      exec: deps.exec,
      scriptPath: gate.scriptPath,
      cwd: appRoot,
      reference: built.reference,
      logDir: join(workDir, "preflight-logs"),
      timeoutMs: deps.preflightTimeoutMs,
      onOutput: (chunk) => log.append(chunk),
    });
    if (!preflight.ok) {
      throw new Error(
        preflight.timedOut
          ? `the preflight gate did not finish within ${deps.preflightTimeoutMs}ms and was killed — nothing was pushed or deployed`
          : `the preflight gate refused the image (exit ${preflight.code}) — nothing was pushed or deployed`,
      );
    }
    await log.flush();

    // ---- push -------------------------------------------------------------
    current = "push";
    steps.push(current);
    await advance("pushing", "preflight");
    const pushed = await deps.images.push({
      tag,
      onOutput: (chunk) => log.append(chunk),
    });
    log.line(
      pushed.pushed
        ? `pushed ${pushed.reference}${pushed.digest ? ` (${pushed.digest})` : ""}`
        : `kept ${pushed.reference} local (no registry configured)`,
    );
    await log.flush();

    // ---- deploy -----------------------------------------------------------
    current = "deploy";
    steps.push(current);

    // The stack is resolved BEFORE the `deploying` write so its id can be
    // stamped on the build row in the same statement. That stamp is what lets
    // the sweep find the stack of a build it reaps: a worker killed between
    // here and the `running` transition below leaves the stack in
    // `publishing`, a status only this function can leave.
    const stack = await loadRunningStack(deps, row.environmentId);
    await advance("deploying", "pushing", { stackId: stack.id });

    await deps.stackService.transition({
      stackId: stack.id,
      to: "publishing",
      expectedFrom: "running",
      actor: BUILDER_ACTOR,
      detail: { buildId },
    });
    stackPublishing = stack.id;

    await deployStack(deps, {
      refs: stack.refs,
      imageUrl: pushed.reference,
      log,
    });

    // ---- finish -----------------------------------------------------------
    current = "finish";
    steps.push(current);
    // The build row first: it is the record of the attempt, and it must carry
    // the digest even if a later write were to fail.
    await advance("succeeded", "deploying", {
      ...(pushed.digest ? { imageDigest: pushed.digest } : {}),
      ...(row.engineVersion ? { engineVersion: row.engineVersion } : {}),
      stackId: stack.id,
    });
    await deps.db
      .update(stacks)
      .set({
        imageDigest: pushed.digest,
        ...(row.engineVersion ? { engineVersion: row.engineVersion } : {}),
        updatedAt: new Date(),
      })
      .where(eq(stacks.id, stack.id));
    await deps.stackService.transition({
      stackId: stack.id,
      to: "running",
      expectedFrom: "publishing",
      actor: BUILDER_ACTOR,
      detail: { buildId, imageDigest: pushed.digest },
    });
    stackPublishing = null;

    log.line(`deployed ${pushed.reference}`);
    await log.flush();
    await auditBuild(deps, row, "build.deployed", {
      reference: pushed.reference,
      imageDigest: pushed.digest,
      stackId: stack.id,
    });

    return {
      buildId,
      status: "succeeded",
      steps,
      transitions,
      reference: pushed.reference,
      imageDigest: pushed.digest,
      usedTemplateDockerfile,
      workDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.line(`✗ [${current}] ${message}`);
    await log.flush();

    // The stack must not be left claiming a publish that never landed. A
    // half-applied deploy is an ERROR (the retry edge exists from there), never
    // a quiet return to `running`.
    if (stackPublishing) {
      await deps.stackService
        .recordError({
          stackId: stackPublishing,
          error: `[build ${buildId}] ${message}`,
          step: "publish",
          actor: BUILDER_ACTOR,
        })
        .catch(() => {});
    }

    await deps.buildService
      .transition({
        buildId,
        to: "failed",
        error: `[${current}] ${message}`,
        actor: BUILDER_ACTOR,
      })
      .catch(() => {});
    transitions.push("failed");

    return {
      buildId,
      status: "failed",
      steps,
      transitions,
      failedStep: current,
      error: message,
      workDir,
    };
  } finally {
    // Always, both paths: a build host does not keep tenants' source trees —
    // neither the unpacked tree nor the staged archive copy.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(archiveScratch, { force: true }).catch(() => {});
  }
}

/**
 * Install the preflight gate into the unpacked app, OVERWRITING whatever the
 * archive shipped, and return the path to run.
 *
 * The archive's own `scripts/preflight.sh` is never executed. It is a file a
 * stranger uploaded, and this process runs on a shared build host that holds
 * the control plane's credentials; "run the tenant's shell script" is remote
 * code execution with the master key in the environment, however plausible the
 * file's name. Docker at least confines a `RUN` step to a container — a
 * `bash <tarball>/scripts/preflight.sh` has no boundary at all.
 *
 * The template's copy is written INTO the app tree rather than run from the
 * template directory so the gate still reads the TENANT's config: the script
 * derives its own `ROOT` from `dirname $0/..`, and its railway-parity check
 * compares the run commands against the `railway.toml` sitting next to it.
 * Trusted code, tenant data — which is the only combination that is both safe
 * and useful.
 */
export async function installPreflightScript(
  appRoot: string,
  templateDir: string,
): Promise<{ scriptPath: string; replacedArchiveCopy: boolean }> {
  const scriptPath = join(appRoot, "scripts", "preflight.sh");
  const replacedArchiveCopy = await pathExists(scriptPath);
  await mkdir(dirname(scriptPath), { recursive: true });
  await copyFile(join(templateDir, "scripts", "preflight.sh"), scriptPath);
  return { scriptPath, replacedArchiveCopy };
}

/**
 * The ONLY variables the preflight gate is given.
 *
 * An allowlist rather than `process.env` minus a denylist: this worker's
 * environment holds `CLOUD_ENCRYPTION_SECRET` (the key that decrypts every
 * tenant's stack secrets), the control-plane DSN, the substrate token and the
 * Stripe key, and the gate's stdout is streamed verbatim into a build log the
 * tenant reads on their own dashboard. A denylist is a list you can forget to
 * extend; this is a list you have to extend on purpose.
 *
 * What survives is what a docker-driving shell script cannot work without:
 * where to find binaries, where the docker client keeps its socket and config,
 * and where to write temporary files.
 */
export const PREFLIGHT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const;

export function preflightEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // The gate boots a PRODUCTION image, so that is what it is told it is —
  // never the control plane's own mode, which in a preview deploy would be
  // `development` and change what the app under test validates.
  const allowed: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of PREFLIGHT_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) allowed[key] = value;
  }
  return allowed;
}

/**
 * How long the gate may run before it is killed and the build failed.
 *
 * Every other command this pipeline starts is bounded (the image store passes
 * its own ceiling to `build`, `push` and `inspect`); an unbounded one here
 * would let a script that never returns pin a process, hold the environment's
 * single-flight slot, and freeze the build row's `updated_at` so even the
 * stale-build sweep could not tell it from healthy work.
 */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run the generalized preflight gate against an already-built image.
 *
 * Invoked through `bash` explicitly rather than relying on the executable bit:
 * the archive's modes are normalised by the unpacker, and a gate that silently
 * failed to start would be a gate that never refuses anything.
 *
 * `env` is passed explicitly and is never optional here — see
 * {@link preflightEnv}.
 */
export async function runPreflight(args: {
  exec: ExecFn;
  scriptPath: string;
  cwd: string;
  reference: string;
  logDir: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}): Promise<{ ok: boolean; code: number; timedOut: boolean }> {
  await mkdir(args.logDir, { recursive: true });
  const result = await args.exec(
    "bash",
    [
      args.scriptPath,
      "--image",
      args.reference,
      "--no-build",
      "--log-dir",
      args.logDir,
    ],
    {
      cwd: args.cwd,
      env: preflightEnv(),
      timeoutMs: args.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
      onOutput: args.onOutput,
    },
  );
  return {
    ok: result.code === 0 && !result.timedOut,
    code: result.code,
    timedOut: result.timedOut,
  };
}

/** The stack a build deploys onto, or a refusal naming what is wrong. */
async function loadRunningStack(
  deps: BuildDeps,
  environmentId: string,
  log?: BuildLog,
): Promise<{ id: string; refs: StackRefs }> {
  const deadline = Date.now() + deps.stackWaitMs;
  let announced: string | null = null;

  // Poll rather than read once. The status is written by ANOTHER process (the
  // provisioner, possibly on another host), so there is nothing to await and no
  // event to subscribe to — the row is the channel. Every read is fresh, so a
  // stack that comes up mid-wait is seen on the next tick.
  for (;;) {
    const [stack] = await deps.db
      .select()
      .from(stacks)
      .where(eq(stacks.environmentId, environmentId))
      .limit(1);
    if (!stack) {
      throw new Error(
        `environment ${environmentId} has no stack — provision it before publishing`,
      );
    }

    if (stack.status === "running") {
      const refs = readStackRefs(stack);
      if (!refs) {
        throw new Error(
          `stack ${stack.id} carries no substrate refs — it has never been provisioned`,
        );
      }
      if (announced) log?.line(`stack ${stack.id} is running; continuing`);
      return { id: stack.id, refs };
    }

    // Not coming up on its own, or the wait is spent. Either way the message is
    // the same one this check has always given.
    if (!STACK_WAIT_STATUSES.has(stack.status) || Date.now() >= deadline) {
      throw new Error(
        `stack ${stack.id} is ${stack.status}, not running — a publish deploys onto a running stack only`,
      );
    }

    // One line per PHASE, not per poll: this streams into the build's log tail
    // and the dashboard, and a line every five seconds for twenty minutes is
    // noise that would bury the build's own output.
    if (announced !== stack.status) {
      announced = stack.status;
      log?.line(
        `waiting for stack ${stack.id} (${stack.status}) — the first publish provisions this environment`,
      );
      // Flushed immediately, unlike the stage-boundary rule: the next boundary
      // may be twenty minutes away, and a customer watching a build that says
      // nothing for twenty minutes is watching a hang.
      await log?.flush();
    }

    await deps.sleep(deps.stackWaitPollMs);
  }
}

/**
 * Ask the substrate to roll the new image out, worker FIRST and api second.
 *
 * Read what this does and does NOT promise, because the difference matters:
 *
 *  - What it does: attaches the migrate pre-deploy command to the WORKER's
 *    instance, so the substrate runs the migration to completion before any
 *    worker process boots on the new image, and fails that rollout if it fails.
 *    The worker is chosen because it takes no inbound traffic — the safe place
 *    for a broken image to be discovered.
 *  - What it does NOT: wait. `SubstrateProvider.deployImage` TRIGGERS a rollout
 *    and returns once the substrate has accepted it (see `substrate/types.ts`);
 *    there is no readiness read in the seam. So the api's rollout is requested
 *    seconds after the worker's, the two overlap, and a migration that fails
 *    surfaces asynchronously at the substrate rather than as a throw here.
 *
 * Which is why `builds.status = succeeded` asserts exactly this much: the image
 * was built, passed the gate, reached the registry, and both rollouts were
 * accepted. Whether the containers then STAYED up is an observation, and it
 * belongs to the health sweep (`pipeline/health-poll.ts`), which reads every
 * running stack every minute and raises a dashboard alert on three consecutive
 * unhealthy reads. Claiming more here would be a status this code cannot back.
 */
async function deployStack(
  deps: BuildDeps,
  args: { refs: StackRefs; imageUrl: string; log: BuildLog },
): Promise<void> {
  for (const [index, service] of DEPLOY_ORDER.entries()) {
    await deps.substrate.deployImage(args.refs, {
      imageUrl: args.imageUrl,
      service,
      ...(index === 0 ? { preDeployCommand: MIGRATE_PRE_DEPLOY_COMMAND } : {}),
    });
    args.log.line(`rollout requested for ${service}`);
  }
}

/** Audit under the environment's organization — the tenant that published. */
async function auditBuild(
  deps: BuildDeps,
  row: BuildRow,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const [environment] = await deps.db
    .select({ organizationId: environments.organizationId })
    .from(environments)
    .where(eq(environments.id, row.environmentId))
    .limit(1);
  if (!environment) return;
  await writeAudit(deps.db, {
    actor: BUILDER_ACTOR,
    organizationId: environment.organizationId,
    action,
    subject: row.id,
    detail: { ...detail, environmentId: row.environmentId },
  }).catch(() => {});
}
