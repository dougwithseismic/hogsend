import type { RailwayClient } from "../substrate/railway/client";
import {
  EXEC_NOT_STARTED,
  type ExecFn,
  MAX_CAPTURED_OUTPUT_CHARS,
} from "./exec";
import { quoteShellArg, renderArgv } from "./shell-quote";

/**
 * The Railway-Sandbox build host (PRD 14 task 3).
 *
 * `cloud-worker` has no Docker daemon; a Railway Sandbox does (proven live:
 * Docker 29.1.2 as root with a live docker.sock, `docker build` AND
 * `docker run` both exit 0 — `run` working is what preserves the preflight
 * gate, which RUNS the built image). This module turns one sandbox into an
 * `ExecFn`, which is the only seam the seven pipeline stages cross to start a
 * command — so the pipeline itself is unchanged.
 *
 * Lifecycle is per build and ALWAYS torn down: the session lazily creates its
 * sandbox on the first command, and `dispose()` destroys it on every path —
 * success, stage failure, thrown error. A leaked sandbox is a running VM
 * nobody is watching; `idleTimeoutMinutes` is the backstop for the one case
 * teardown itself cannot cover (this process dying mid-build).
 *
 * The worker and the sandbox have SEPARATE filesystems. The pipeline's own
 * filesystem work (unpack, Dockerfile fallback, preflight install) happens on
 * the worker; the bootstrap reproduces the same tree inside the sandbox at
 * the same `workDir` path — download the artifact from its presigned URL,
 * extract it, and install the platform's template files by the pipeline's own
 * rules (preflight.sh always overwrites; the template Dockerfile only lands
 * when the archive shipped none) — so every path the stages put into an argv
 * resolves inside the sandbox exactly as it does on the worker.
 */

/** What Railway's `sandboxExec` returns. */
export interface SandboxExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * The sandbox API seam. Narrow on purpose: tests supply a fake and never
 * reach the live (beta) API, and the one real implementation reuses the
 * substrate's `RailwayClient` — its retry policy, its 400 classification —
 * rather than growing a second HTTP layer.
 */
export interface SandboxApi {
  create(input: {
    environmentId: string;
    idleTimeoutMinutes: number;
    region?: string;
  }): Promise<{ id: string }>;
  exec(input: {
    id: string;
    environmentId: string;
    command: string;
    timeoutSec: number;
  }): Promise<SandboxExecOutcome>;
  destroy(input: { id: string; environmentId: string }): Promise<void>;
}

// GOTCHA (recorded from the live spike): `sandboxExec` and `sandboxDestroy`
// BOTH require `environmentId`, and both return object types that need
// subfield selections — a bare `sandboxDestroy(...)` is a schema error.
const SANDBOX_CREATE = `
  mutation SandboxCreate($input: SandboxCreateInput!) {
    sandboxCreate(input: $input) { id }
  }
`;

const SANDBOX_EXEC = `
  mutation SandboxExec($id: String!, $environmentId: String!, $command: String!, $timeoutSec: Int) {
    sandboxExec(id: $id, environmentId: $environmentId, command: $command, timeoutSec: $timeoutSec) {
      exitCode stdout stderr timedOut truncated
    }
  }
`;

const SANDBOX_DESTROY = `
  mutation SandboxDestroy($id: String!, $environmentId: String!) {
    sandboxDestroy(id: $id, environmentId: $environmentId) { id }
  }
`;

/** The real API, over the substrate's retrying GraphQL client. */
export class RailwaySandboxApi implements SandboxApi {
  constructor(private readonly client: RailwayClient) {}

  async create(input: {
    environmentId: string;
    idleTimeoutMinutes: number;
    region?: string;
  }): Promise<{ id: string }> {
    const data = await this.client.request<{
      sandboxCreate: { id: string };
    }>(SANDBOX_CREATE, {
      input: {
        environmentId: input.environmentId,
        idleTimeoutMinutes: input.idleTimeoutMinutes,
        ...(input.region ? { region: input.region } : {}),
      },
    });
    return { id: data.sandboxCreate.id };
  }

  async exec(input: {
    id: string;
    environmentId: string;
    command: string;
    timeoutSec: number;
  }): Promise<SandboxExecOutcome> {
    const data = await this.client.request<{
      sandboxExec: SandboxExecOutcome;
    }>(SANDBOX_EXEC, input);
    return data.sandboxExec;
  }

  async destroy(input: { id: string; environmentId: string }): Promise<void> {
    await this.client.request(SANDBOX_DESTROY, input);
  }
}

/**
 * `ExecOptions.env` keys that are HOST-MACHINE facts and must NOT be
 * forwarded into the sandbox: the worker's PATH points at the worker's
 * binaries, its DOCKER_* at the worker's (absent) daemon. Mirrors
 * `PREFLIGHT_ENV_ALLOWLIST` in `pipeline/build.ts` — those keys exist
 * precisely to pass the LOCAL machine through, which is meaningless remotely.
 * Everything else in `options.env` (e.g. the gate's `NODE_ENV=production`)
 * is a deliberate setting and IS forwarded, quoted.
 */
const HOST_MACHINE_ENV_KEYS = new Set([
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
]);

/** No pipeline command is unbounded on the local path either; this is the
 * ceiling when a caller passes no `timeoutMs`. */
export const DEFAULT_SANDBOX_EXEC_TIMEOUT_SEC = 3600;

/** Ceiling on the bootstrap (download + extract + login): a 64MB tarball on
 * a datacenter link plus a registry round trip, with a wide margin. */
export const SANDBOX_BOOTSTRAP_TIMEOUT_SEC = 600;

export interface SandboxRegistryLogin {
  /** The registry HOST, e.g. `ghcr.io` — not the namespaced prefix. */
  server: string;
  username: string;
  /** NEVER logged, never surfaced in any output or error message. */
  password: string;
}

export interface SandboxBuildSessionOptions {
  api: SandboxApi;
  /** The Railway environment sandboxes are created in. */
  environmentId: string;
  region?: string;
  /** The leak backstop — see the module doc. */
  idleTimeoutMinutes?: number;
  /** The pipeline's per-build unpack directory, reproduced verbatim. */
  workDir: string;
  /** Presigned, short-lived. Treated as a secret: never logged, and a
   * failed download reports a generic message rather than curl's (which
   * echoes the URL). */
  artifactUrl: string;
  /** Contents of the scaffold template's `Dockerfile`. */
  templateDockerfile: string;
  /** Contents of the scaffold template's `scripts/preflight.sh`. */
  templatePreflight: string;
  /** Absent → no login; `docker push` then only works against a registry
   * that needs none. */
  registryLogin?: SandboxRegistryLogin;
  defaultTimeoutSec?: number;
}

export interface SandboxBuildSession {
  exec: ExecFn;
  /** Destroy the sandbox if one was created. Never throws — a failed destroy
   * is logged and left to `idleTimeoutMinutes`, because throwing from a
   * `finally` would mask the build's real outcome. */
  dispose(): Promise<void>;
}

/**
 * The bootstrap script, run once right after the sandbox is created.
 *
 * Template file contents travel as base64 (`printf %s … | base64 -d`):
 * base64 text is shell-inert by construction, so multi-kilobyte trusted files
 * need no quoting argument at all. The app-root probe reproduces
 * `resolveAppRoot` (lib/tarball.ts): the root itself if it holds a
 * package.json, else a SINGLE nested directory that does.
 *
 * curl's stderr is discarded on purpose: its error lines echo the URL, and
 * the presigned URL is a bearer credential for the tenant's source.
 */
export function buildBootstrapScript(opts: {
  workDir: string;
  artifactUrl: string;
  templateDockerfile: string;
  templatePreflight: string;
}): string {
  const work = quoteShellArg(opts.workDir);
  const archive = quoteShellArg(`${opts.workDir}.artifact.tar.gz`);
  const url = quoteShellArg(opts.artifactUrl);
  const dockerfileB64 = Buffer.from(opts.templateDockerfile).toString("base64");
  const preflightB64 = Buffer.from(opts.templatePreflight).toString("base64");
  return [
    "set -eu",
    `mkdir -p ${work}`,
    `curl -fsSL --retry 3 -o ${archive} ${url} 2>/dev/null || { echo 'artifact download failed'; exit 70; }`,
    `tar -xzf ${archive} -C ${work}`,
    // resolveAppRoot, in shell: prefer the root, else the single child
    // directory that carries a package.json.
    `APP=${work}`,
    'if [ ! -f "$APP/package.json" ]; then',
    '  count=0; only=""',
    '  for d in "$APP"/*/; do [ -d "$d" ] || continue; count=$((count+1)); only="$d"; done',
    '  if [ "$count" = 1 ] && [ -f "${only}package.json" ]; then APP="${only%/}"; fi',
    "fi",
    // The pipeline's rules, verbatim: the template Dockerfile only when the
    // archive shipped none; the platform's preflight.sh ALWAYS (an uploaded
    // script is never executed on a build host).
    'if [ ! -f "$APP/Dockerfile" ]; then',
    `  printf %s '${dockerfileB64}' | base64 -d > "$APP/Dockerfile"`,
    "fi",
    'mkdir -p "$APP/scripts"',
    `printf %s '${preflightB64}' | base64 -d > "$APP/scripts/preflight.sh"`,
  ].join("\n");
}

/**
 * The `docker login` command. Stdin-based (`--password-stdin`), never an
 * argument to docker — and the secret enters the pipe via `printf %s '…'`
 * with the tested quoting, so no metacharacter in a password can break out.
 * The command STRING necessarily carries the secret (sandboxExec has no
 * separate stdin channel); the containment rule is therefore that this
 * module never logs, echoes, or surfaces a command string anywhere — login
 * output included, which is why the login result's output is dropped rather
 * than appended to any build log.
 */
export function buildLoginCommand(login: SandboxRegistryLogin): string {
  return (
    `printf %s ${quoteShellArg(login.password)} | ` +
    `docker login ${quoteShellArg(login.server)} ` +
    `-u ${quoteShellArg(login.username)} --password-stdin`
  );
}

export function createSandboxBuildSession(
  options: SandboxBuildSessionOptions,
): SandboxBuildSession {
  const {
    api,
    environmentId,
    idleTimeoutMinutes = 60,
    defaultTimeoutSec = DEFAULT_SANDBOX_EXEC_TIMEOUT_SEC,
  } = options;

  /** Set as soon as create RESOLVES, even if bootstrap then fails: a
   * half-bootstrapped sandbox is still a running VM to destroy. */
  let sandboxId: string | undefined;
  /** Single-flight init — the pipeline is sequential, but the guard costs
   * nothing and makes the invariant local. */
  let ready: Promise<string> | undefined;

  const bootstrap = async (): Promise<string> => {
    const created = await api.create({
      environmentId,
      idleTimeoutMinutes,
      ...(options.region ? { region: options.region } : {}),
    });
    sandboxId = created.id;

    const script = buildBootstrapScript(options);
    const setup = await api.exec({
      id: created.id,
      environmentId,
      command: script,
      timeoutSec: SANDBOX_BOOTSTRAP_TIMEOUT_SEC,
    });
    if (setup.exitCode !== 0 || setup.timedOut) {
      // The script's own stdout/stderr is safe to surface (curl's is
      // discarded inside it), and "which line refused" is the whole
      // difference between a fixable failure and a shrug.
      throw new Error(
        `sandbox bootstrap failed (exit ${setup.exitCode}${
          setup.timedOut ? ", timed out" : ""
        }): ${(setup.stdout + setup.stderr).slice(-2000)}`,
      );
    }

    if (options.registryLogin) {
      const login = await api.exec({
        id: created.id,
        environmentId,
        command: buildLoginCommand(options.registryLogin),
        timeoutSec: 120,
      });
      if (login.exitCode !== 0 || login.timedOut) {
        // Deliberately WITHOUT the command or its output: both sit one typo
        // away from a credential, and "login to <server> failed" is enough
        // to act on.
        throw new Error(
          `docker login to ${options.registryLogin.server} failed inside the sandbox (exit ${login.exitCode})`,
        );
      }
    }

    return created.id;
  };

  const exec: ExecFn = async (command, args, execOptions = {}) => {
    let id: string;
    try {
      ready ??= bootstrap();
      id = await ready;
    } catch (error) {
      // Mirror `spawnExec`: "the command could not be started" is a RESULT
      // (exit 127), not a rejection — the pipeline then fails the current
      // stage with a legible message instead of an unhandled throw.
      return {
        code: EXEC_NOT_STARTED,
        output: `sandbox build host unavailable: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
        timedOut: false,
      };
    }

    let shell = renderArgv(command, args);
    const forwarded = Object.entries(execOptions.env ?? {}).filter(
      ([key, value]) => value !== undefined && !HOST_MACHINE_ENV_KEYS.has(key),
    );
    if (forwarded.length > 0) {
      const pairs = forwarded
        .map(([key, value]) => quoteShellArg(`${key}=${value}`))
        .join(" ");
      shell = `env ${pairs} ${shell}`;
    }
    if (execOptions.cwd) {
      shell = `cd ${quoteShellArg(execOptions.cwd)} && ${shell}`;
    }

    const timeoutSec = execOptions.timeoutMs
      ? Math.max(1, Math.ceil(execOptions.timeoutMs / 1000))
      : defaultTimeoutSec;

    let outcome: SandboxExecOutcome;
    try {
      outcome = await api.exec({
        id,
        environmentId,
        command: shell,
        timeoutSec,
      });
    } catch (error) {
      return {
        code: EXEC_NOT_STARTED,
        output: `sandbox exec failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
        timedOut: false,
      };
    }

    // Merged, stdout first — the same "one stream" contract spawnExec keeps.
    // sandboxExec returns the whole output at completion (no streaming), so
    // onOutput fires once; the BuildLog treats a chunk as a chunk either way.
    let output = outcome.stdout;
    if (outcome.stderr) {
      if (output && !output.endsWith("\n")) output += "\n";
      output += outcome.stderr;
    }
    if (outcome.truncated) {
      output += "\n[sandbox] output truncated by the sandbox API\n";
    }
    output = output.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    execOptions.onOutput?.(output);
    return { code: outcome.exitCode, output, timedOut: outcome.timedOut };
  };

  const dispose = async (): Promise<void> => {
    if (sandboxId === undefined) return;
    const id = sandboxId;
    sandboxId = undefined;
    try {
      await api.destroy({ id, environmentId });
    } catch (error) {
      // See the interface doc: never throw from teardown. The idle timeout
      // reaps what this could not, and the notice is for the operator.
      process.stderr.write(
        `${JSON.stringify({
          service: "cloud-build-host",
          event: "sandbox_destroy_failed",
          sandboxId: id,
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }
  };

  return { exec, dispose };
}
