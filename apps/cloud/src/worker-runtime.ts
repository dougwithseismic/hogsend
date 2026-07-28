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
  event: "boot" | "heartbeat" | "shutdown" | "tasks";
  [key: string]: unknown;
}

/** The minimal shape this runtime needs from a registered Hatchet worker. */
export interface HatchetWorkerHandle {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface WorkerConfig {
  /** The control-plane Postgres DSN. Never logged. */
  databaseUrl: string;
  nodeEnv: "development" | "production" | "test";
  /** Heartbeat cadence. One line a minute is enough to prove liveness. */
  heartbeatMs: number;
  /** Log sink. Defaults to a JSON line on stdout. */
  log: (line: WorkerLogLine) => void;
  /**
   * Whether the control plane's Hatchet is configured. When true the worker
   * registers the `provision-stack` task; when false it idles (dev under the
   * fake substrate, where the in-process queue covers provisioning).
   */
  hatchetConfigured: boolean;
  /**
   * The substrate this deploy provisions against. Anything but `fake` makes a
   * missing Hatchet a BOOT FAILURE (PRD 04): a control plane that would
   * provision real infrastructure from a web request is worse than one that
   * refuses to start.
   */
  substrate: string;
  /** Builds + starts the Hatchet worker. Injected so tests need no engine. */
  startHatchetWorker: () => Promise<HatchetWorkerHandle>;
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
  const hatchetConfigured = config.hatchetConfigured ?? false;
  const substrate = config.substrate ?? "fake";

  if (!config.databaseUrl || config.databaseUrl.trim() === "") {
    throw new Error(
      "cloud-worker: CLOUD_DATABASE_URL is required and must not be empty",
    );
  }

  // Fail CLOSED. Under a real substrate the durable queue IS the provisioner;
  // without it nothing would ever pick a `requested` stack up, and the control
  // plane would look healthy while provisioning silently never happened.
  if (!hatchetConfigured && substrate !== "fake") {
    throw new Error(
      `cloud-worker: CLOUD_SUBSTRATE=${substrate} requires CLOUD_HATCHET_CLIENT_TOKEN (provisioning must be durable)`,
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
    // 1 = `provision-stack`. Zero means "no Hatchet configured, this worker is
    // idling" — the gap is explicit rather than implied.
    tasks: hatchetConfigured ? 1 : 0,
  });

  let hatchetWorker: HatchetWorkerHandle | undefined;
  const registration: Promise<void> =
    hatchetConfigured && config.startHatchetWorker
      ? config
          .startHatchetWorker()
          .then((worker) => {
            hatchetWorker = worker;
            log({ service: "cloud-worker", event: "tasks", registered: 1 });
          })
          .catch((error) => {
            // Registration happens after boot (the gRPC handshake is async), so
            // a failure has to be LOUD here or it would be invisible.
            log({
              service: "cloud-worker",
              event: "tasks",
              registered: 0,
              error: error instanceof Error ? error.message : String(error),
            });
          })
      : Promise.resolve();

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
      // Await registration first: stopping a worker that is still handshaking
      // would leave the connection open behind us.
      await registration;
      await hatchetWorker?.stop();
      log({
        service: "cloud-worker",
        event: "shutdown",
        uptimeMs: Date.now() - startedAt,
      });
    },
  };
}
