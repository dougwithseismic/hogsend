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
 */
const HEARTBEAT_KEY = "hogsend:worker:heartbeat";
const TTL_SECONDS = 30;
const REFRESH_MS = 10_000;

export interface WorkerHeartbeat {
  /** True when a fresh worker heartbeat is present in Redis. */
  alive: boolean;
  /** ISO timestamp the worker last wrote, when alive. */
  lastSeenAt?: string;
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
      await getRedis().set(
        HEARTBEAT_KEY,
        new Date().toISOString(),
        "EX",
        TTL_SECONDS,
      );
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

/** Read the current worker heartbeat. Resolves to `{ alive: false }` if Redis is unreachable. */
export async function getWorkerHeartbeat(): Promise<WorkerHeartbeat> {
  try {
    const lastSeenAt = await getRedis().get(HEARTBEAT_KEY);
    return lastSeenAt ? { alive: true, lastSeenAt } : { alive: false };
  } catch {
    return { alive: false };
  }
}
