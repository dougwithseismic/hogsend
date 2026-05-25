import { Redis } from "ioredis";

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  }
  return _redis;
}

export function getRedisIfConnected(): Redis | undefined {
  return _redis;
}
