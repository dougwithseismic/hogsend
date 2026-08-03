import { spawn } from "node:child_process";

/**
 * The process seam.
 *
 * Every external command the build pipeline runs — `docker`, the preflight
 * script — goes through an injected `ExecFn`. That is what lets the whole
 * pipeline be proved in a unit test with no docker daemon, no registry and no
 * bash, and it is the same one-directional-ignorance rule the substrate seam
 * holds: nothing above this line knows how a process is started.
 *
 * The contract has one sharp edge worth stating: a nonzero exit is a RESULT,
 * not a rejection. The caller decides what a failing docker build means; a
 * throw here would make "the command ran and said no" indistinguishable from
 * "the command could not be started".
 */

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Merged stdout+stderr, as it arrives. The build log is built from this. */
  onOutput?: (chunk: string) => void;
  /** Kill the child after this long. Absent → no limit. */
  timeoutMs?: number;
}

export interface ExecResult {
  code: number;
  /** Merged stdout+stderr, bounded by {@link MAX_CAPTURED_OUTPUT_CHARS}. */
  output: string;
  /** True when the process was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * The captured output kept in MEMORY per command. The build's persisted tail is
 * bounded separately and much smaller; this ceiling exists so one chatty docker
 * build cannot grow the worker's heap without limit.
 */
export const MAX_CAPTURED_OUTPUT_CHARS = 256 * 1024;

/** The exit code reported when the command could not be started at all. */
export const EXEC_NOT_STARTED = 127;

/** The real implementation: `spawn`, no shell, merged output. */
export const spawnExec: ExecFn = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    const append = (chunk: string): void => {
      options.onOutput?.(chunk);
      output = (output + chunk).slice(-MAX_CAPTURED_OUTPUT_CHARS);
    };

    // `shell: false` (the default) is deliberate: every argument here is
    // assembled from tenant-influenced values (paths, tags), and a shell would
    // turn one of them into an injection point.
    //
    // `detached: true` puts the child in its own PROCESS GROUP. The commands
    // run here are wrappers — `bash` around `docker run`, `docker` around a
    // build — so SIGKILL to the immediate child on a timeout would reap the
    // wrapper and orphan the containers it started. The group is what makes a
    // timeout actually free the host.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const killTree = (): void => {
      // Negative pid = the whole group. It can fail (the group is already
      // gone, or the platform has no groups), and the direct kill is the
      // fallback rather than the plan.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree();
        }, options.timeoutMs)
      : undefined;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output, timedOut });
    };

    child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    child.on("error", (error: Error) => {
      append(`${error.message}\n`);
      finish(EXEC_NOT_STARTED);
    });
    child.on("close", (code) => finish(code ?? EXEC_NOT_STARTED));
  });
