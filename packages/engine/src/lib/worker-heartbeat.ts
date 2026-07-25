import { type BootDiagnostic, getBootDiagnostics } from "./boot-diagnostics.js";
import type { Logger } from "./logger.js";
import { getRedis } from "./redis.js";

/**
 * Worker liveness heartbeat. The worker and API are separate processes, so the
 * API (and the Studio, via `GET /v1/health`) cannot otherwise tell whether a
 * worker is actually connected — which is exactly the "journeys silently don't
 * fire because the worker isn't running" footgun. The worker writes a TTL'd key
 * to Redis on an interval; readers treat its presence as "a worker is alive".
 *
 * Redis is the channel because the health route already probes Redis and both
 * processes can reach it — no direct process-to-process coupling, no migration.
 * Everything here is best-effort: a missing/unreachable Redis never crashes the
 * worker and simply reads back as "down".
 *
 * The heartbeat also carries the worker's BOOT DIAGNOSTICS. The collector
 * (lib/boot-diagnostics.ts) is per-OS-process memory and only the API process
 * serves HTTP (`worker.ts` starts no server; the worker service has no
 * healthcheck) — yet the opt-in credentials (TWILIO_*, APOLLO_API_KEY) are
 * consumed by worker-side execution, and Railway env is per-service. A
 * worker-only misconfiguration would therefore record into a collector no
 * surface can read — #611's evidence lived on exactly that process. Riding the
 * existing heartbeat gets those entries across the boundary with no new
 * channel or infrastructure.
 */
const HEARTBEAT_KEY = "hogsend:worker:heartbeat";
const TTL_SECONDS = 30;
const REFRESH_MS = 10_000;

// Reads are raced against a deadline INSIDE getWorkerHeartbeat: an
// unreachable Redis makes ioredis buffer the GET across reconnect backoff
// instead of rejecting promptly, and both /v1/health and /v1/admin/config
// call this — neither may hang on a diagnostics read.
const READ_TIMEOUT_MS = 1500;

export interface WorkerHeartbeat {
  /** True when a fresh worker heartbeat is present in Redis. */
  alive: boolean;
  /** ISO timestamp the worker last wrote, when alive. */
  lastSeenAt?: string;
  /**
   * Boot diagnostics recorded in the WORKER process, published on the
   * heartbeat payload (see module doc). Absent when the payload is legacy
   * (a pre-diagnostics worker's bare timestamp) or malformed — readers
   * degrade to the API-only view rather than erroring.
   */
  diagnostics?: readonly BootDiagnostic[];
}

/**
 * Begin writing the worker heartbeat. Writes once immediately, then refreshes
 * every {@link REFRESH_MS} with a {@link TTL_SECONDS} expiry — so an ungraceful
 * worker death is reflected as "down" within the TTL. Returns a stop function
 * that clears the timer and deletes the key for an immediate "down" signal on
 * graceful shutdown.
 */
export function startWorkerHeartbeat(logger: Logger): () => Promise<void> {
  let warned = false;
  const write = async () => {
    try {
      // JSON payload on the SAME key and TTL as always: `lastSeenAt` keeps
      // the liveness contract; `diagnostics` piggybacks this process's
      // collector so worker-only misconfigurations reach the API's surfaces
      // (/v1/health count, /v1/admin/config detail). Snapshotted per write
      // (every REFRESH_MS) so late recordings — e.g. a diagnostic recorded
      // after an async provider prime settles — still propagate.
      const payload = JSON.stringify({
        lastSeenAt: new Date().toISOString(),
        diagnostics: getBootDiagnostics(),
      });
      await getRedis().set(HEARTBEAT_KEY, payload, "EX", TTL_SECONDS);
    } catch (err) {
      // Log the first failure only — a Redis-less deploy would otherwise spam.
      if (!warned) {
        warned = true;
        logger.debug("Worker heartbeat write failed (Redis unreachable?)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  void write();
  const timer = setInterval(() => void write(), REFRESH_MS);
  // Never hold the process open for the heartbeat alone.
  timer.unref?.();

  return async () => {
    clearInterval(timer);
    try {
      await getRedis().del(HEARTBEAT_KEY);
    } catch {
      // Best-effort — the TTL expires it anyway.
    }
  };
}

function isBootDiagnostic(value: unknown): value is BootDiagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BootDiagnostic).code === "string" &&
    typeof (value as BootDiagnostic).message === "string"
  );
}

/**
 * Interpret a heartbeat payload. Key presence alone proves a worker wrote
 * recently, so every branch returns `alive: true` — the payload shape only
 * decides how much detail rides along:
 *
 * - JSON `{ lastSeenAt, diagnostics }` — the current worker format.
 * - a bare ISO timestamp — a pre-diagnostics worker (mixed-version deploy
 *   window); liveness keeps working, diagnostics degrade to the API-only view.
 * - anything else / malformed — degrade to bare liveness, never throw: a
 *   broken payload must not take /v1/health or /v1/admin/config down.
 */
function parseHeartbeat(raw: string): WorkerHeartbeat {
  if (!raw.startsWith("{")) {
    // Legacy bare-timestamp payload.
    return { alive: true, lastSeenAt: raw };
  }
  try {
    // A text starting with `{` parses to a non-null object or JSON.parse throws
    // (caught below), so no primitive/null guard is needed here.
    const { lastSeenAt, diagnostics } = JSON.parse(raw) as {
      lastSeenAt?: unknown;
      diagnostics?: unknown;
    };
    return {
      alive: true,
      lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : undefined,
      // Validate entry-by-entry — one malformed entry must not discard the
      // rest — and rebuild each object so a foreign writer on the key can't
      // smuggle extra fields into the admin response.
      diagnostics: Array.isArray(diagnostics)
        ? diagnostics
            .filter(isBootDiagnostic)
            .map(({ code, message }) => ({ code, message }))
        : undefined,
    };
  } catch {
    return { alive: true };
  }
}

/**
 * Read the current worker heartbeat. Never throws and never hangs: resolves
 * to `{ alive: false }` if Redis is unreachable or doesn't answer within
 * {@link READ_TIMEOUT_MS}.
 */
export async function getWorkerHeartbeat(): Promise<WorkerHeartbeat> {
  try {
    const raw = await Promise.race([
      getRedis().get(HEARTBEAT_KEY),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("worker heartbeat read timed out")),
          READ_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
    return raw ? parseHeartbeat(raw) : { alive: false };
  } catch {
    return { alive: false };
  }
}
