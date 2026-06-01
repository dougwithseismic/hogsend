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
    });
  }
  return _redis;
}

export function getRedisIfConnected(): Redis | undefined {
  return _redis;
}
