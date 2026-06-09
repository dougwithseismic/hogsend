import { Redis } from "ioredis";

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      // Railway private networking (*.railway.internal) is IPv6-only; without
      // family: 0, ioredis only tries IPv4 and silently fails to connect —
      // which is why Postgres (postgres.js does dual-stack) worked but Redis
      // didn't. family: 0 lets DNS resolve both A and AAAA. Harmless locally.
      family: 0,
      // Connect on first command (e.g. the /v1/health probe), not at import.
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 3,
      // Retry a transient blip a few times, then give up cleanly. Without a cap,
      // an environment with no redis (tests, self-host without redis) keeps a
      // socket retrying forever — which hangs vitest and leaks handles. In prod
      // redis is reachable, so it connects on the first try and never gives up.
      retryStrategy: (times) =>
        times > 5 ? null : Math.min(times * 300, 1500),
    });
  }
  return _redis;
}

export function getRedisIfConnected(): Redis | undefined {
  return _redis;
}

/**
 * Namespace for better-auth's secondary-storage keys so they never collide with
 * the PostHog person-property cache or the worker heartbeat sharing this Redis.
 */
const AUTH_STORAGE_PREFIX = "hogsend:auth:";

/**
 * The minimal shape better-auth's `secondaryStorage` option expects. Mirrors
 * `@better-auth/core`'s `SecondaryStorage` so we don't pull a type out of a deep
 * subpath: `get` returns the raw stored string (better-auth `JSON.parse`s it),
 * `set` takes an optional TTL in SECONDS, `delete` removes the key.
 */
export interface AuthSecondaryStorage {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

/**
 * Adapt an ioredis client to better-auth's `secondaryStorage` contract so all
 * better-auth session AND rate-limit counters live in Redis — shared across
 * Railway replicas and surviving restarts. Without this, better-auth defaults
 * `rateLimit.storage` to in-memory (per-instance, reset on redeploy), so the
 * sign-in / request-password-reset limits are materially weaker than they look
 * on a multi-replica deploy (security finding #2).
 *
 * Reuses the SHARED engine Redis singleton ({@link getRedis}) — it never opens a
 * second pool. better-auth gives `set` a TTL in SECONDS, which we honour with
 * `EX`; entries with no TTL persist (matching better-auth's own behaviour).
 *
 * Every operation is wrapped so a Redis blip degrades gracefully instead of
 * crashing the auth flow: `get` returns `null` (better-auth treats it as a
 * miss), `set`/`delete` no-op. We never want a transient cache fault to take
 * down sign-in.
 */
export function createRedisSecondaryStorage(
  redis: Redis,
): AuthSecondaryStorage {
  const k = (key: string) => `${AUTH_STORAGE_PREFIX}${key}`;
  return {
    async get(key) {
      try {
        return await redis.get(k(key));
      } catch {
        return null;
      }
    },
    async set(key, value, ttl) {
      try {
        if (typeof ttl === "number" && ttl > 0) {
          await redis.set(k(key), value, "EX", ttl);
        } else {
          await redis.set(k(key), value);
        }
      } catch {
        // Degrade to no-op — never fail the auth flow on a cache write.
      }
    },
    async delete(key) {
      try {
        await redis.del(k(key));
      } catch {
        // Degrade to no-op.
      }
    },
  };
}
