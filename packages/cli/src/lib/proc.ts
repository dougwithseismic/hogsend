import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Process orchestration primitives for `hogsend dev`.
 *
 * The contract here is pinned (PROJECT_SPEC §d): `spawnManaged`,
 * `shutdownAll`, `waitForHttp`. Everything else is additive.
 */

/** How a managed child finished. */
export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  /** Resolves once the child has fully exited (additive to the pinned contract). */
  exited: Promise<ProcessExit>;
  /** Register a callback fired once on exit; fires immediately if already exited. */
  onExit(cb: (info: ProcessExit) => void): void;
}

/**
 * Spawn a long-running child with line-prefixed stdio.
 *
 * On POSIX the child is spawned `detached`, making it its own process-group
 * leader. That is the no-orphans mechanism: (a) the terminal's Ctrl-C SIGINT
 * hits only our process (not the children), so the orderly shutdown can't be
 * raced, and (b) {@link shutdownAll} can kill the whole tree (`pnpm` →
 * `tsx watch` → app) with a negative-pid group kill.
 */
export function spawnManaged(opts: {
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  prefixColor: (s: string) => string;
  /**
   * Optional line sink (additive — exists so tests can capture output).
   * Defaults to process.stdout/stderr writes.
   */
  sink?: (line: string) => void;
}): ManagedProcess {
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, FORCE_COLOR: "1", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const prefix = opts.prefixColor(`[${opts.name}]`);
  const writeOut = opts.sink ?? ((line: string) => process.stdout.write(line));
  const writeErr = opts.sink ?? ((line: string) => process.stderr.write(line));

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => writeOut(`${prefix} ${line}\n`));
  }
  if (child.stderr) {
    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => writeErr(`${prefix} ${line}\n`));
  }

  const callbacks: Array<(info: ProcessExit) => void> = [];
  let exitInfo: ProcessExit | null = null;
  const exited = new Promise<ProcessExit>((resolve) => {
    const settle = (info: ProcessExit) => {
      if (exitInfo) return;
      exitInfo = info;
      resolve(info);
      for (const cb of callbacks) cb(info);
    };
    child.once("close", (code, signal) => settle({ code, signal }));
    // A spawn failure (e.g. command not found) may never emit `close`.
    child.once("error", (err) => {
      writeErr(`${prefix} failed to start: ${err.message}\n`);
      settle({ code: null, signal: null });
    });
  });

  return {
    name: opts.name,
    child,
    exited,
    onExit(cb) {
      if (exitInfo) {
        cb(exitInfo);
        return;
      }
      callbacks.push(cb);
    },
  };
}

function hasExited(proc: ManagedProcess): boolean {
  return (
    proc.child.pid === undefined ||
    proc.child.exitCode !== null ||
    proc.child.signalCode !== null
  );
}

/**
 * Send `signal` to the child's whole process group (POSIX), falling back to a
 * direct kill on Windows or when the group kill fails. Swallows ESRCH
 * (already dead).
 */
function killTree(proc: ManagedProcess, signal: NodeJS.Signals): void {
  const pid = proc.child.pid;
  if (pid === undefined || hasExited(proc)) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      proc.child.kill(signal);
    }
  } catch {
    try {
      proc.child.kill(signal);
    } catch {
      // already dead — nothing to do
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gracefully stop every managed process: SIGTERM the process groups, wait up
 * to `timeoutMs` (default 5s), then SIGKILL any stragglers. Idempotent — safe
 * to call twice (e.g. SIGINT and SIGTERM both arriving) and tolerant of
 * already-exited children.
 */
export async function shutdownAll(
  procs: ManagedProcess[],
  opts?: { timeoutMs?: number },
): Promise<void> {
  if (procs.length === 0) return;
  const timeoutMs = opts?.timeoutMs ?? 5000;

  for (const proc of procs) killTree(proc, "SIGTERM");

  const allExited = Promise.all(procs.map((p) => p.exited));
  await Promise.race([allExited, sleep(timeoutMs)]);

  const stragglers = procs.filter((p) => !hasExited(p));
  if (stragglers.length === 0) return;

  for (const proc of stragglers) killTree(proc, "SIGKILL");
  // Give the SIGKILLed children a beat to be reaped so callers don't return
  // while the OS still lists them.
  await Promise.race([allExited, sleep(2000)]);
}

/**
 * Poll `url` every 500ms (2s per-attempt timeout) until it answers 2xx, or
 * reject after `timeoutMs` with an actionable message carrying the URL and
 * the last failure (connection error vs non-2xx status).
 */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt completed";

  do {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `last response: HTTP ${res.status}`;
    } catch (err) {
      lastError = `last error: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    await sleep(500);
  } while (Date.now() < deadline);

  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${url} (${lastError})`,
  );
}
