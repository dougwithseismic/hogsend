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
