/**
 * The cloud-worker runtime — the process that will host the control plane's
 * durable provisioning tasks (PRD 04). Today it is a skeleton: it validates
 * its configuration, announces itself, and idles.
 *
 * It is deliberately split from the entry point (`src/worker.ts`): everything
 * here is a plain function over injected config, so the boot contract is
 * unit-testable without spawning a process, and the entry keeps the only two
 * things a library must never grab — `process.env` reads and signal handlers.
 */

/** One structured log record. Serialized as a single JSON line on stdout. */
export interface WorkerLogLine {
  service: "cloud-worker";
  event: "boot" | "heartbeat" | "shutdown";
  [key: string]: unknown;
}

export interface WorkerConfig {
  /** The control-plane Postgres DSN. Never logged. */
  databaseUrl: string;
  nodeEnv: "development" | "production" | "test";
  /** Heartbeat cadence. One line a minute is enough to prove liveness. */
  heartbeatMs: number;
  /** Log sink. Defaults to a JSON line on stdout. */
  log: (line: WorkerLogLine) => void;
}

export interface WorkerHandle {
  /** False once `stop()` has run. */
  readonly running: boolean;
  /** Idempotent: stopping an already-stopped worker resolves and logs nothing. */
  stop(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 60_000;

function defaultLog(line: WorkerLogLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Starts the worker. Throws synchronously on invalid configuration — a worker
 * that boots without a database would idle forever pretending to be healthy.
 */
export function startWorker(config: Partial<WorkerConfig> = {}): WorkerHandle {
  const log = config.log ?? defaultLog;
  const nodeEnv = config.nodeEnv ?? "development";
  const heartbeatMs = config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  if (!config.databaseUrl || config.databaseUrl.trim() === "") {
    throw new Error(
      "cloud-worker: CLOUD_DATABASE_URL is required and must not be empty",
    );
  }

  const startedAt = Date.now();
  log({
    service: "cloud-worker",
    event: "boot",
    env: nodeEnv,
    node: process.version,
    pid: process.pid,
    heartbeatMs,
    // Task registration lands with PRD 04; the count makes the gap explicit.
    tasks: 0,
  });

  // Unref'd would let an idle process exit; the interval is what holds the
  // event loop open until a signal arrives.
  const timer: NodeJS.Timeout = setInterval(() => {
    log({
      service: "cloud-worker",
      event: "heartbeat",
      uptimeMs: Date.now() - startedAt,
    });
  }, heartbeatMs);

  let running = true;

  return {
    get running() {
      return running;
    },
    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      clearInterval(timer);
      // Where a future task registry's `worker.stop()` await goes.
      log({
        service: "cloud-worker",
        event: "shutdown",
        uptimeMs: Date.now() - startedAt,
      });
    },
  };
}
